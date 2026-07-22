import { lstatSync, mkdirSync, watch as watchDir } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Context, Effect, Either, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import { applyMirrorLaw, decodeCanvasDoc, serializeCanvas, type CanvasDoc } from "@shared/canvas";
import type { CanvasReadResult, CanvasSummary, CanvasWriteResult } from "@shared/ipc";
import { SEED_CANVAS_NAME } from "@shared/seed";

export class CanvasError extends Schema.TaggedError<CanvasError>()("CanvasError", {
  message: Schema.String,
}) {}

declare const canvasNameBrand: unique symbol;
/** A filesystem-safe, canonical canvas basename minted at the repository boundary. */
export type CanvasName = string & { readonly [canvasNameBrand]: "CanvasName" };

const NAME_PATTERN = /^[a-z0-9-]+$/;
const SIDECAR_SUFFIXES = ["digest.txt", "svg"] as const;
type SidecarSuffix = (typeof SIDECAR_SUFFIXES)[number];

/**
 * Canonicalize the human-facing spelling used by the existing UI, then refuse
 * anything which is not one ASCII basename. This is deliberately stricter
 * than path normalization: traversal, separators, dot files, Unicode lookalikes
 * and encoded separators are data, never paths.
 */
export const canvasNameFrom = (raw: string): CanvasName => {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0 || !NAME_PATTERN.test(normalized)) {
    throw new CanvasError({
      message: `invalid canvas name "${raw}": use lowercase letters, numbers, and hyphens only`,
    });
  }
  return normalized as CanvasName;
};

// Overridable for hermetic headless probes/tests (scripts/kernel-headless-probe.ts)
// so they never touch the operator's real ~/.vellum/canvases. Unset in normal
// (dev or packaged) operation — production behavior is unchanged.
export const canvasesDir = () =>
  resolve(process.env.VELLUM_CANVASES_DIR || join(homedir(), ".vellum", "canvases"));

const confinedPath = (root: string, fileName: string): string => {
  const path = resolve(root, fileName);
  if (dirname(path) !== root) {
    throw new CanvasError({ message: "canvas path escaped the configured canvas directory" });
  }
  return path;
};

export const canvasDocumentPath = (rawName: string): string =>
  confinedPath(canvasesDir(), `${canvasNameFrom(rawName)}.canvas`);

export const canvasSidecarPath = (rawName: string, suffix: SidecarSuffix): string =>
  confinedPath(canvasesDir(), `${canvasNameFrom(rawName)}.${suffix}`);

/** Ensure the configured repository itself is a real directory, never a symlink. */
export const ensureCanvasesDir = async (): Promise<string> => {
  const root = canvasesDir();
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CanvasError({ message: `canvas directory is not a real directory: ${root}` });
  }
  return root;
};

/** Never follow a canvas-file symlink. A write refuses it rather than replacing a surprise target. */
const assertRegularOrMissing = async (path: string): Promise<void> => {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new CanvasError({ message: `refusing non-regular canvas file: ${basename(path)}` });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
};

/** Mint a root-confined document path only after the repository and target are safe. */
export const canvasDocumentPathForRead = async (rawName: string): Promise<string> => {
  await ensureCanvasesDir();
  const path = canvasDocumentPath(rawName);
  await assertRegularOrMissing(path);
  return path;
};

/** Write an allowlisted derivative through a same-directory atomic rename. */
export const writeCanvasSidecar = async (
  rawName: string,
  suffix: SidecarSuffix,
  contents: string,
): Promise<string> => {
  await ensureCanvasesDir();
  const path = canvasSidecarPath(rawName, suffix);
  await assertRegularOrMissing(path);
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, contents, { encoding: "utf8", flag: "wx" });
    await rename(tmpPath, path);
    return path;
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

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

const canvasFileName = (name: CanvasName) => `${name}.canvas`;
const canvasPath = (name: CanvasName) => canvasDocumentPath(name);

const WATCH_DEBOUNCE_MS = 300;
const MAX_MUTATE_REVISION_RETRIES = 8;

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
      const root = await ensureCanvasesDir();
      const files = (await readdir(root)).filter((file) => {
        if (!file.endsWith(".canvas")) return false;
        try {
          canvasNameFrom(basename(file, ".canvas"));
          return true;
        } catch {
          return false;
        }
      });
      const summaries = await Promise.all(
        files.map(async (file): Promise<CanvasSummary | null> => {
          const name = canvasNameFrom(basename(file, ".canvas"));
          const path = canvasPath(name);
          try {
            await assertRegularOrMissing(path);
          } catch {
            // A directory entry is untrusted external input. Ignore a
            // symlink/special file rather than traversing it or making the
            // whole repository unavailable.
            return null;
          }
          const info = await stat(path);
          return {
            name,
            path,
            modifiedAt: info.mtime.toISOString(),
          };
        }),
      );
      return summaries
        .filter((summary): summary is CanvasSummary => summary !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    catch: toCanvasError,
  });

  const revisionOf = (raw: string): string =>
    createHash("sha256").update(raw, "utf8").digest("hex");

  // Shared by read() and mutate(): parse + decode the file on disk. Thrown
  // errors are CanvasError already, so callers can let them propagate as-is.
  const readAndDecode = async (
    name: CanvasName,
  ): Promise<{ readonly doc: CanvasDoc; readonly revision: string }> => {
    await ensureCanvasesDir();
    const path = canvasPath(name);
    await assertRegularOrMissing(path);
    const raw = await readFile(path, "utf8");

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
        const canonicalName = canvasNameFrom(name);
        const result = await readAndDecode(canonicalName);
        return { name: canonicalName, path: canvasPath(canonicalName), ...result };
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
        withCanvasMutex(canvasFileName(canvasNameFrom(name)), async () => {
          const canonicalName = canvasNameFrom(name);
          const decoded = decodeCanvasDoc(doc);
          if (Either.isLeft(decoded)) {
            throw new CanvasError({
              message: `cannot write ${canvasFileName(canonicalName)}: ${decoded.left.message}`,
            });
          }

          const serialized = serializeCanvas(applyMirrorLaw(decoded.right));
          const revision = revisionOf(serialized);

          await ensureCanvasesDir();
          const path = canvasPath(canonicalName);
          await assertRegularOrMissing(path);
          if (expectedRevision !== undefined) {
            let currentRevision: string | undefined;
            try {
              currentRevision = revisionOf(await readFile(path, "utf8"));
            } catch {
              currentRevision = undefined;
            }
            if (currentRevision !== expectedRevision) {
              throw new CanvasError({
              message: `${canvasFileName(canonicalName)} changed on disk; reload before saving`,
              });
            }
          }
          // Unique per write so two overlapping writers (even outside the
          // mutex above, e.g. a separate OS process like populate.ts) never
          // share one tmp file.
          const tmpPath = `${path}.${randomUUID()}.tmp`;
          await writeFile(tmpPath, serialized, { encoding: "utf8", flag: "wx" });
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
              message: `${canvasFileName(canonicalName)} changed on disk; reload before saving`,
              });
            }
          }
          await rename(tmpPath, path);

          // Suppress fs.watch echo, then notify subscribers ourselves so the
          // kernel rehydrates immediately. Without this, own-write suppression
          // leaves kernel docs stale after normal UI writeCanvas (tasks done,
          // criteria edits) and live phase/blocked paint lies.
          ownWrites.set(canvasFileName(canonicalName), revision);
          for (const listener of listeners) listener(canonicalName);
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
        withCanvasMutex(canvasFileName(canvasNameFrom(name)), async () => {
          const canonicalName = canvasNameFrom(name);
          await ensureCanvasesDir();
          const path = canvasPath(canonicalName);
          await assertRegularOrMissing(path);
          for (let attempt = 0; attempt < MAX_MUTATE_REVISION_RETRIES; attempt += 1) {
            const current = await readAndDecode(canonicalName);
            const next = fn(current.doc);

            const decoded = decodeCanvasDoc(next);
            if (Either.isLeft(decoded)) {
              throw new CanvasError({
                message: `cannot mutate ${canvasFileName(canonicalName)}: ${decoded.left.message}`,
              });
            }

            const serialized = serializeCanvas(applyMirrorLaw(decoded.right));
            const revision = revisionOf(serialized);
            const tmpPath = `${path}.${randomUUID()}.tmp`;
            await writeFile(tmpPath, serialized, { encoding: "utf8", flag: "wx" });

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

            ownWrites.set(canvasFileName(canonicalName), revision);
            for (const listener of listeners) listener(canonicalName);
            return;
          }

          throw new CanvasError({
            message: `${canvasFileName(canonicalName)} kept changing on disk; mutation was not applied`,
          });
        }),
      catch: toCanvasError,
    });

  const sanitizeName = (name: string): Effect.Effect<CanvasName, CanvasError> =>
    Effect.try({ try: () => canvasNameFrom(name), catch: toCanvasError });

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
  const remove = (name: string): Effect.Effect<{ name: string }, CanvasError> =>
    Effect.gen(function* () {
      const sanitized = yield* sanitizeName(name);

      yield* Effect.tryPromise({
        try: () =>
          withCanvasMutex(canvasFileName(sanitized), async () => {
            await ensureCanvasesDir();
            const path = canvasPath(sanitized);
            await assertRegularOrMissing(path);
            try {
              await stat(path);
            } catch {
              throw new CanvasError({ message: `canvas "${sanitized}" does not exist` });
            }

            await rm(path);

            for (const suffix of SIDECAR_SUFFIXES) {
              try {
                await rm(canvasSidecarPath(sanitized, suffix));
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
        const root = await ensureCanvasesDir();
        return (await readdir(root)).filter((file) => file.endsWith(".canvas"));
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
        const canonicalName = canvasNameFrom(name);
        if (!SIDECAR_SUFFIXES.includes(suffix as SidecarSuffix)) {
          throw new CanvasError({ message: `unsupported canvas sidecar suffix "${suffix}"` });
        }
        return await writeCanvasSidecar(canonicalName, suffix as SidecarSuffix, contents);
      },
      catch: toCanvasError,
    });

  const start = () => {
    if (watcher) return;

    try {
      mkdirSync(canvasesDir(), { recursive: true });
      const rootInfo = lstatSync(canvasesDir());
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new CanvasError({ message: `canvas directory is not a real directory: ${canvasesDir()}` });
      }
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

          let name: CanvasName;
          try {
            name = canvasNameFrom(basename(fileName, ".canvas"));
          } catch {
            return;
          }
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
