import { mkdirSync, watch as watchDir } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Context, Effect, Either, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import { applyMirrorLaw, decodeCanvasDoc, serializeCanvas, type CanvasDoc } from "@shared/canvas";
import type { CanvasReadResult, CanvasSummary, CanvasWriteResult } from "@shared/ipc";
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
    readonly write: (
      name: string,
      doc: CanvasDoc,
      expectedRevision?: string,
    ) => Effect.Effect<CanvasWriteResult, CanvasError>;
    // Retrying optimistic read-modify-write under the same per-canvas mutex
    // as write(). fn must be a pure/idempotent document transform because an
    // external direct-file write can make mutate re-read and reapply it.
    readonly mutate: (
      name: string,
      fn: (doc: CanvasDoc) => CanvasDoc,
    ) => Effect.Effect<void, CanvasError>;
    readonly create: (name: string) => Effect.Effect<CanvasReadResult, CanvasError>;
    // Removes the canvas document and its known derived sidecars (digest/svg).
    // Notifies change subscribers so the kernel can drop hydrated state. Does
    // not touch arming intent (operator may re-open a same-named canvas later).
    readonly remove: (name: string) => Effect.Effect<{ name: string }, CanvasError>;
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

const WATCH_DEBOUNCE_MS = 300;
const MAX_MUTATE_REVISION_RETRIES = 8;

const NAME_PATTERN = /^[a-z0-9-]+$/;

export const CanvasesLive = Layer.sync(CanvasesService, () => {
  const listeners = new Set<(name: string) => void>();
  // Exact content identity, rather than a time window. A near-immediate
  // external write differs from this identity and must never be swallowed as
  // an echo of our own atomic rename. null represents an own deletion.
  const ownWrites = new Map<string, string | null>();
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

  const revisionOf = (raw: string): string =>
    createHash("sha256").update(raw, "utf8").digest("hex");

  // Shared by read() and mutate(): parse + decode the file on disk. Thrown
  // errors are CanvasError already, so callers can let them propagate as-is.
  const readAndDecode = async (
    name: string,
  ): Promise<{ readonly doc: CanvasDoc; readonly revision: string }> => {
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

    return { doc: decoded.right, revision: revisionOf(raw) };
  };

  const read = (name: string): Effect.Effect<CanvasReadResult, CanvasError> =>
    Effect.tryPromise({
      try: async () => {
        const result = await readAndDecode(name);
        return { name, path: canvasPath(name), ...result };
      },
      catch: toCanvasError,
    });

  // Validates, applies the mirror law, serializes canonically, and writes
  // atomically (tmp file + rename). Records the write so start()'s watcher
  // can suppress the echo it will otherwise see.
  const write = (
    name: string,
    doc: CanvasDoc,
    expectedRevision?: string,
  ): Effect.Effect<CanvasWriteResult, CanvasError> =>
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
          const revision = revisionOf(serialized);

          await mkdir(canvasesDir(), { recursive: true });
          const path = canvasPath(name);
          if (expectedRevision !== undefined) {
            let currentRevision: string | undefined;
            try {
              currentRevision = revisionOf(await readFile(path, "utf8"));
            } catch {
              currentRevision = undefined;
            }
            if (currentRevision !== expectedRevision) {
              throw new CanvasError({
                message: `${canvasFileName(name)} changed on disk; reload before saving`,
              });
            }
          }
          // Unique per write so two overlapping writers (even outside the
          // mutex above, e.g. a separate OS process like populate.ts) never
          // share one tmp file.
          const tmpPath = `${path}.${randomUUID()}.tmp`;
          await writeFile(tmpPath, serialized, "utf8");
          // Recheck immediately before replacement. This rejects when an
          // external document differs at either revision read, and rename
          // guarantees the installed file is complete. It is not an atomic
          // filesystem compare-and-swap: direct writers do not share our
          // mutex, so a write in the final read-to-rename interval can still
          // be replaced. Node's portable rename API has no conditional form.
          if (expectedRevision !== undefined) {
            let currentRevision: string | undefined;
            try {
              currentRevision = revisionOf(await readFile(path, "utf8"));
            } catch {
              currentRevision = undefined;
            }
            if (currentRevision !== expectedRevision) {
              await rm(tmpPath, { force: true });
              throw new CanvasError({
                message: `${canvasFileName(name)} changed on disk; reload before saving`,
              });
            }
          }
          await rename(tmpPath, path);

          // Suppress fs.watch echo, then notify subscribers ourselves so the
          // kernel rehydrates immediately. Without this, own-write suppression
          // leaves kernel docs stale after normal UI writeCanvas (tasks done,
          // criteria edits) and live phase/blocked paint lies.
          ownWrites.set(canvasFileName(name), revision);
          for (const listener of listeners) listener(name);
          return { revision };
        }),
      catch: toCanvasError,
    });

  // Same mutex key as write() (canvasFileName(name)), so in-process writes
  // serialize. Direct file writers do not share that mutex: detect their
  // revision immediately before rename and reapply the idempotent transform
  // to the newest document. As with write(), the final read-to-rename window
  // cannot be a true portable filesystem compare-and-swap.
  const mutate = (name: string, fn: (doc: CanvasDoc) => CanvasDoc): Effect.Effect<void, CanvasError> =>
    Effect.tryPromise({
      try: () =>
        withCanvasMutex(canvasFileName(name), async () => {
          await mkdir(canvasesDir(), { recursive: true });
          const path = canvasPath(name);
          for (let attempt = 0; attempt < MAX_MUTATE_REVISION_RETRIES; attempt += 1) {
            const current = await readAndDecode(name);
            const next = fn(current.doc);

            const decoded = decodeCanvasDoc(next);
            if (Either.isLeft(decoded)) {
              throw new CanvasError({
                message: `cannot mutate ${canvasFileName(name)}: ${decoded.left.message}`,
              });
            }

            const serialized = serializeCanvas(applyMirrorLaw(decoded.right));
            const revision = revisionOf(serialized);
            const tmpPath = `${path}.${randomUUID()}.tmp`;
            await writeFile(tmpPath, serialized, "utf8");

            let observedRevision: string | undefined;
            try {
              observedRevision = revisionOf(await readFile(path, "utf8"));
            } catch {
              observedRevision = undefined;
            }
            if (observedRevision !== current.revision) {
              await rm(tmpPath, { force: true });
              continue;
            }

            try {
              await rename(tmpPath, path);
            } catch (error) {
              await rm(tmpPath, { force: true });
              throw error;
            }

            ownWrites.set(canvasFileName(name), revision);
            for (const listener of listeners) listener(name);
            return;
          }

          throw new CanvasError({
            message: `${canvasFileName(name)} kept changing on disk; mutation was not applied`,
          });
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

  // Known agent-surface derivatives written next to the document. Best-effort:
  // a missing sidecar is fine; a missing .canvas is the hard failure.
  const SIDECAR_SUFFIXES = ["digest.txt", "svg"] as const;

  const remove = (name: string): Effect.Effect<{ name: string }, CanvasError> =>
    Effect.gen(function* () {
      const sanitized = yield* sanitizeName(name);

      yield* Effect.tryPromise({
        try: () =>
          withCanvasMutex(canvasFileName(sanitized), async () => {
            const path = canvasPath(sanitized);
            try {
              await stat(path);
            } catch {
              throw new CanvasError({ message: `canvas "${sanitized}" does not exist` });
            }

            await rm(path);

            for (const suffix of SIDECAR_SUFFIXES) {
              try {
                await rm(join(canvasesDir(), `${sanitized}.${suffix}`));
              } catch {
                // sidecar may not exist
              }
            }

            // Suppress the fs.watch echo of our own unlink, then notify
            // subscribers ourselves so kernel resync drops the doc even when
            // watch is down or the delete event is coalesced away.
            ownWrites.set(canvasFileName(sanitized), null);
            for (const listener of listeners) listener(sanitized);
          }),
        catch: toCanvasError,
      });

      return { name: sanitized };
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

        const timer = setTimeout(async () => {
          debounceTimers.delete(fileName);

          const expectedOwnRevision = ownWrites.get(fileName);
          if (ownWrites.has(fileName)) {
            let actualRevision: string | null;
            try {
              actualRevision = revisionOf(
                await readFile(join(canvasesDir(), fileName), "utf8"),
              );
            } catch {
              actualRevision = null;
            }
            ownWrites.delete(fileName);
            if (actualRevision === expectedOwnRevision) return;
          }

          const name = basename(fileName, ".canvas");
          for (const listener of listeners) listener(name);
        }, WATCH_DEBOUNCE_MS);

        debounceTimers.set(fileName, timer);
      });
      watcher.unref();
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
    remove,
    ensureSeed,
    writeSidecar,
    start,
    subscribeChanges,
  });
});
