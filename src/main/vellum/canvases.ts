import { mkdirSync, watch as watchDir } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Context, Effect, Either, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import { applyMirrorLaw, decodeCanvasDoc, serializeCanvas, type CanvasDoc } from "@shared/canvas";
import type { CanvasReadResult, CanvasSummary } from "@shared/ipc";
import { SEED_CANVAS_NAME } from "@shared/seed";

export class CanvasError extends Schema.TaggedError<CanvasError>()("CanvasError", {
  message: Schema.String,
}) {}

// Overridable for hermetic headless probes/tests (scripts/kernel-headless-probe.ts)
// so they never touch the operator's real ~/.vellum/canvases. Unset in normal
// (dev or packaged) operation — production behavior is unchanged.
export const canvasesDir = () =>
  process.env.VELLUM_CANVASES_DIR || join(homedir(), ".vellum", "canvases");

// The document plane. All writes go through validate -> mirror law ->
// canonical serialize -> atomic write (tmp + rename). The watcher reports
// external edits only: writes made through this service must not echo.
export class CanvasesService extends Context.Tag("@vellum/CanvasesService")<
  CanvasesService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly list: Effect.Effect<ReadonlyArray<CanvasSummary>, CanvasError>;
    readonly read: (name: string) => Effect.Effect<CanvasReadResult, CanvasError>;
    readonly write: (name: string, doc: CanvasDoc) => Effect.Effect<void, CanvasError>;
    // Atomic read-modify-write under the same per-canvas mutex as write():
    // rereads the file, applies fn, validates + writes the result. Used by
    // the kernel's flag mirror so a racing user write and a kernel flag
    // write serialize instead of one clobbering the other's tmp file.
    readonly mutate: (
      name: string,
      fn: (doc: CanvasDoc) => CanvasDoc,
    ) => Effect.Effect<void, CanvasError>;
    readonly create: (name: string) => Effect.Effect<CanvasReadResult, CanvasError>;
    // Creates the seed canvas when the canvases dir is empty. Called at startup.
    readonly ensureSeed: Effect.Effect<void, CanvasError>;
    // Writes a sidecar file next to the canvas (e.g. digest). Returns its path.
    readonly writeSidecar: (
      name: string,
      suffix: string,
      contents: string,
    ) => Effect.Effect<string, CanvasError>;
    // Begin watching the canvases dir. Idempotent.
    readonly start: () => void;
    readonly subscribeChanges: (listener: (name: string) => void) => () => void;
  }
>() {}

const toCanvasError = (error: unknown): CanvasError =>
  error instanceof CanvasError
    ? error
    : new CanvasError({ message: error instanceof Error ? error.message : String(error) });

const canvasFileName = (name: string) => `${name}.canvas`;
const canvasPath = (name: string) => join(canvasesDir(), canvasFileName(name));

// Own-write suppression window: an fs.watch event arriving within this
// window of a write we made ourselves is an echo, not an external edit.
const OWN_WRITE_SUPPRESS_MS = 1500;
const WATCH_DEBOUNCE_MS = 300;

const NAME_PATTERN = /^[a-z0-9-]+$/;

export const CanvasesLive = Layer.sync(CanvasesService, () => {
  const listeners = new Set<(name: string) => void>();
  const ownWrites = new Map<string, number>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: ReturnType<typeof watchDir> | null = null;

  // Per-canvas-file write mutex: overlapping write() calls for the same
  // name queue behind each other instead of racing the same tmp file. Each
  // queued write still runs to completion once its turn comes (its own
  // unique tmp path, its own rename) — a losing writer is delayed, never
  // silently dropped. The tail promise never rejects so one failed write
  // doesn't wedge writers still waiting behind it.
  const canvasMutexes = new Map<string, Promise<void>>();
  const withCanvasMutex = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = canvasMutexes.get(key) ?? Promise.resolve();
    const settled = previous.then(fn, fn);
    canvasMutexes.set(
      key,
      settled.then(
        () => undefined,
        () => undefined,
      ),
    );
    return settled;
  };

  const list: Effect.Effect<ReadonlyArray<CanvasSummary>, CanvasError> = Effect.tryPromise({
    try: async () => {
      await mkdir(canvasesDir(), { recursive: true });
      const files = (await readdir(canvasesDir())).filter((file) => file.endsWith(".canvas"));
      const summaries = await Promise.all(
        files.map(async (file): Promise<CanvasSummary> => {
          const path = join(canvasesDir(), file);
          const info = await stat(path);
          return {
            name: basename(file, ".canvas"),
            path,
            modifiedAt: info.mtime.toISOString(),
          };
        }),
      );
      return summaries.slice().sort((a, b) => a.name.localeCompare(b.name));
    },
    catch: toCanvasError,
  });

  // Shared by read() and mutate(): parse + decode the file on disk. Thrown
  // errors are CanvasError already, so callers can let them propagate as-is.
  const readAndDecode = async (name: string): Promise<CanvasDoc> => {
    const raw = await readFile(canvasPath(name), "utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new CanvasError({
        message: `${canvasFileName(name)} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }

    const decoded = decodeCanvasDoc(parsed);
    if (Either.isLeft(decoded)) {
      throw new CanvasError({
        message: `${canvasFileName(name)} failed validation: ${decoded.left.message}`,
      });
    }

    return decoded.right;
  };

  const read = (name: string): Effect.Effect<CanvasReadResult, CanvasError> =>
    Effect.tryPromise({
      try: async () => ({ name, path: canvasPath(name), doc: await readAndDecode(name) }),
      catch: toCanvasError,
    });

  // Validates, applies the mirror law, serializes canonically, and writes
  // atomically (tmp file + rename). Records the write so start()'s watcher
  // can suppress the echo it will otherwise see.
  const write = (name: string, doc: CanvasDoc): Effect.Effect<void, CanvasError> =>
    Effect.tryPromise({
      try: () =>
        withCanvasMutex(canvasFileName(name), async () => {
          const decoded = decodeCanvasDoc(doc);
          if (Either.isLeft(decoded)) {
            throw new CanvasError({
              message: `cannot write ${canvasFileName(name)}: ${decoded.left.message}`,
            });
          }

          const serialized = serializeCanvas(applyMirrorLaw(decoded.right));

          await mkdir(canvasesDir(), { recursive: true });
          const path = canvasPath(name);
          // Unique per write so two overlapping writers (even outside the
          // mutex above, e.g. a separate OS process like populate.ts) never
          // share one tmp file.
          const tmpPath = `${path}.${randomUUID()}.tmp`;
          await writeFile(tmpPath, serialized, "utf8");
          await rename(tmpPath, path);

          ownWrites.set(canvasFileName(name), Date.now());
        }),
      catch: toCanvasError,
    });

  // Same mutex key as write() (canvasFileName(name)), so a racing user
  // writeCanvas either lands first (mutate rereads it, applies fn on top) or
  // second (clobbers fn's result — self-healed next cycle, since callers
  // like the kernel's flag mirror are level-driven and idempotent). The
  // reread happens INSIDE the mutex so it can never race write()'s own
  // read-less overwrite.
  const mutate = (name: string, fn: (doc: CanvasDoc) => CanvasDoc): Effect.Effect<void, CanvasError> =>
    Effect.tryPromise({
      try: () =>
        withCanvasMutex(canvasFileName(name), async () => {
          const current = await readAndDecode(name);
          const next = fn(current);

          const decoded = decodeCanvasDoc(next);
          if (Either.isLeft(decoded)) {
            throw new CanvasError({
              message: `cannot mutate ${canvasFileName(name)}: ${decoded.left.message}`,
            });
          }

          const serialized = serializeCanvas(applyMirrorLaw(decoded.right));

          await mkdir(canvasesDir(), { recursive: true });
          const path = canvasPath(name);
          const tmpPath = `${path}.${randomUUID()}.tmp`;
          await writeFile(tmpPath, serialized, "utf8");
          await rename(tmpPath, path);

          ownWrites.set(canvasFileName(name), Date.now());
        }),
      catch: toCanvasError,
    });

  const sanitizeName = (name: string): Effect.Effect<string, CanvasError> => {
    const normalized = name.trim().toLowerCase();
    if (normalized.length === 0 || !NAME_PATTERN.test(normalized)) {
      return Effect.fail(
        new CanvasError({
          message: `invalid canvas name "${name}": use lowercase letters, numbers, and hyphens only`,
        }),
      );
    }
    return Effect.succeed(normalized);
  };

  const create = (name: string): Effect.Effect<CanvasReadResult, CanvasError> =>
    Effect.gen(function* () {
      const sanitized = yield* sanitizeName(name);

      const exists = yield* Effect.tryPromise({
        try: async () => {
          try {
            await stat(canvasPath(sanitized));
            return true;
          } catch {
            return false;
          }
        },
        catch: toCanvasError,
      });

      if (exists) {
        return yield* Effect.fail(
          new CanvasError({ message: `canvas "${sanitized}" already exists` }),
        );
      }

      yield* write(sanitized, { nodes: [], edges: [] });
      return yield* read(sanitized);
    });

  const ensureSeed: Effect.Effect<void, CanvasError> = Effect.gen(function* () {
    const files = yield* Effect.tryPromise({
      try: async () => {
        await mkdir(canvasesDir(), { recursive: true });
        return (await readdir(canvasesDir())).filter((file) => file.endsWith(".canvas"));
      },
      catch: toCanvasError,
    });

    if (files.length === 0) {
      yield* write(SEED_CANVAS_NAME, { nodes: [], edges: [] });
    }
  });

  const writeSidecar = (
    name: string,
    suffix: string,
    contents: string,
  ): Effect.Effect<string, CanvasError> =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(canvasesDir(), { recursive: true });
        const path = join(canvasesDir(), `${name}.${suffix}`);
        await writeFile(path, contents, "utf8");
        return path;
      },
      catch: toCanvasError,
    });

  const start = () => {
    if (watcher) return;

    try {
      mkdirSync(canvasesDir(), { recursive: true });
      watcher = watchDir(canvasesDir(), (_eventType, filename) => {
        const fileName = filename?.toString();
        if (!fileName || !fileName.endsWith(".canvas")) return;

        const existingTimer = debounceTimers.get(fileName);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(() => {
          debounceTimers.delete(fileName);

          const lastOwnWrite = ownWrites.get(fileName);
          if (lastOwnWrite !== undefined && Date.now() - lastOwnWrite < OWN_WRITE_SUPPRESS_MS) {
            return;
          }

          const name = basename(fileName, ".canvas");
          for (const listener of listeners) listener(name);
        }, WATCH_DEBOUNCE_MS);

        debounceTimers.set(fileName, timer);
      });
    } catch {
      // Watching is best-effort for the POC: a failure here should not
      // block the rest of the service.
      watcher = null;
    }
  };

  const subscribeChanges = (listener: (name: string) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return CanvasesService.of({
    doctor: Effect.succeed({
      id: "canvases",
      label: "Canvas Documents",
      status: "ok",
      detail: canvasesDir(),
    }),
    list,
    read,
    write,
    mutate,
    create,
    ensureSeed,
    writeSidecar,
    start,
    subscribeChanges,
  });
});
