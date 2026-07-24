import { lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Context, Effect, Either, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import { applyMirrorLaw, decodeCanvasDoc, serializeCanvas, type CanvasDoc } from "@shared/canvas";
import type { CanvasReadResult, CanvasSummary, CanvasWriteResult } from "@shared/ipc";
import {
  CANVAS_NAME_INPUT_PATTERN,
  CANVAS_NAME_MAX_LENGTH,
} from "@shared/canvas-name";
import { SEED_CANVAS_NAME } from "@shared/seed";
import {
  CanvasAuthorityError,
  canvasAuthorityRoot,
  commitAuthorityGeneration,
  loadAuthoritySnapshot,
} from "./canvas-authority/store";

export class CanvasError extends Schema.TaggedError<CanvasError>()("CanvasError", {
  message: Schema.String,
}) {}

declare const canvasNameBrand: unique symbol;
/** A filesystem-safe, canonical canvas basename minted at the repository boundary. */
export type CanvasName = string & { readonly [canvasNameBrand]: "CanvasName" };

const SIDECAR_SUFFIXES = ["digest.txt", "svg"] as const;
type SidecarSuffix = (typeof SIDECAR_SUFFIXES)[number];

/**
 * Canonicalize the human-facing spelling used by the existing UI, then refuse
 * anything which is not one ASCII basename. This is deliberately stricter
 * than path normalization: traversal, separators, dot files, Unicode lookalikes
 * and encoded separators are data, never paths.
 */
export const canvasNameFrom = (raw: string): CanvasName => {
  const trimmed = raw.trim();
  if (!CANVAS_NAME_INPUT_PATTERN.test(trimmed)) {
    throw new CanvasError({
      message: `invalid canvas name "${raw}": use at most ${CANVAS_NAME_MAX_LENGTH} ASCII letters, numbers, hyphens, and underscores`,
    });
  }
  return trimmed.toLowerCase() as CanvasName;
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

const canvasDocumentPathIn = (root: string, name: CanvasName): string =>
  confinedPath(root, `${name}.canvas`);

const canvasSidecarPathIn = (root: string, name: CanvasName, suffix: SidecarSuffix): string =>
  confinedPath(root, `${name}.${suffix}`);

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

const syncDirectoryBestEffort = async (root: string): Promise<void> => {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(root, "r");
    await directory.sync();
  } catch (error) {
    // The rename/create is already committed. Reporting failure here would
    // invite an unsafe retry, so retain success and surface the durability
    // limitation diagnostically.
    console.error("[canvases] directory sync failed after committed write:", error);
  } finally {
    await directory?.close().catch(() => undefined);
  }
};

const writeExclusiveTemp = async (tmpPath: string, contents: string): Promise<void> => {
  const file = await open(tmpPath, "wx", 0o600);
  try {
    await file.writeFile(contents, { encoding: "utf8" });
    await file.sync();
    await file.close();
  } catch (error) {
    await file.close().catch(() => undefined);
    // open("wx") succeeded, so this exact temporary entry belongs to us.
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const atomicReplaceTextFile = async (path: string, contents: string): Promise<void> => {
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  let ownsTemp = false;
  try {
    await writeExclusiveTemp(tmpPath, contents);
    ownsTemp = true;
    await rename(tmpPath, path);
    ownsTemp = false;
  } catch (error) {
    if (ownsTemp) await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectoryBestEffort(dirname(path));
};

/** Mint a root-confined document path only after the repository and target are safe. */
export const canvasDocumentPathForRead = async (rawName: string): Promise<string> => {
  const root = await ensureCanvasesDir();
  const path = canvasDocumentPathIn(root, canvasNameFrom(rawName));
  await assertRegularOrMissing(path);
  return path;
};

/**
 * Write an allowlisted agent-facing derivative under canvasesDir.
 * Sidecars are projections for agents (digest/svg), not product durability.
 */
export const writeCanvasSidecar = async (
  rawName: string,
  suffix: SidecarSuffix | string,
  contents: string,
): Promise<string> => {
  if (!SIDECAR_SUFFIXES.includes(suffix as SidecarSuffix)) {
    throw new CanvasError({ message: `unsupported canvas sidecar suffix "${suffix}"` });
  }
  const name = canvasNameFrom(rawName);
  const root = await ensureCanvasesDir();
  const path = canvasSidecarPathIn(root, name, suffix as SidecarSuffix);
  await assertRegularOrMissing(path);
  await atomicReplaceTextFile(path, contents);
  return path;
};

// The document plane. All writes go through validate -> mirror law ->
// serialize -> full-map authority generation commit.
//
// Sole durable store: canvas-authority-v1 (`current.json` + content-addressed
// objects under ~/.vellum/state/canvas-authority-v1).
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
    // Optimistic RMW under the per-canvas mutex against the live authority
    // document.
    readonly mutate: (
      name: string,
      fn: (doc: CanvasDoc) => CanvasDoc,
    ) => Effect.Effect<void, CanvasError>;
    readonly create: (name: string) => Effect.Effect<CanvasReadResult, CanvasError>;
    // Removes the canvas from the next authority generation and agent sidecars.
    // Notifies change subscribers so the kernel can drop hydrated state.
    readonly remove: (name: string) => Effect.Effect<{ name: string }, CanvasError>;
    // Creates the seed canvas when authority is empty. Called at startup.
    readonly ensureSeed: Effect.Effect<void, CanvasError>;
    // Writes an agent-facing sidecar (digest/svg). Returns its path.
    readonly writeSidecar: (
      name: string,
      suffix: string,
      contents: string,
    ) => Effect.Effect<string, CanvasError>;
    // Bootstraps the live map from the authority store once (idempotent).
    readonly start: () => void;
    readonly subscribeChanges: (listener: (name: string) => void) => () => void;
    /** Snapshot of live authority docs for process-bind caller resolution. */
    readonly liveDocuments: () => Effect.Effect<
      ReadonlyArray<{ readonly canvasName: string; readonly doc: CanvasDoc }>,
      CanvasError
    >;
    /**
     * Replace live authority with a fully decoded document set (projection
     * install). Commits one full-map generation. Names not in the set are
     * removed. Callers must validate the set before invoking.
     */
    readonly replaceLiveAuthorityDocuments: (
      documents: ReadonlyMap<string, CanvasDoc>,
    ) => Effect.Effect<void, CanvasError>;
  }
>() {}

const toCanvasError = (error: unknown): CanvasError =>
  error instanceof CanvasError
    ? error
    : new CanvasError({ message: error instanceof Error ? error.message : String(error) });

const canvasFileName = (name: CanvasName) => `${name}.canvas`;

export const CanvasesLive = Layer.sync(CanvasesService, () => {
  const listeners = new Set<(name: string) => void>();
  const textEncoder = new TextEncoder();

  // Live operator-intent map. Durability is canvas-authority-v1 only.
  type LiveAuthority = {
    readonly doc: CanvasDoc;
    readonly revision: string;
    readonly path: string;
  };
  const liveAuthority = new Map<string, LiveAuthority>();
  let bootstrapPromise: Promise<void> | undefined;
  let bootstrapped = false;
  /** Last committed authority generation (BigInt). Next commit is +1n. */
  let authorityGeneration = 0n;
  /**
   * Non-empty when the store is unusable (corrupt generation, orphan objects
   * without pointer). Mutations refuse; doctor reports the reason.
   */
  let authorityBlocked: string | undefined;

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

  // Global queue for authority generations (store API: single writer).
  let authorityMutex: Promise<void> = Promise.resolve();
  const withAuthorityMutex = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = authorityMutex.then(fn, fn);
    authorityMutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const notifyListeners = (name: CanvasName): void => {
    for (const listener of listeners) {
      try {
        listener(name);
      } catch (error) {
        // The document operation is already committed. A subscriber cannot
        // retroactively turn it into a failed write/delete and invite retry.
        console.error(`[canvases] change listener failed for ${name}:`, error);
      }
    }
  };

  const revisionOf = (raw: string): string =>
    createHash("sha256").update(raw, "utf8").digest("hex");

  const decodeDocumentBytes = (
    name: CanvasName,
    path: string,
    bytes: Uint8Array,
  ): LiveAuthority => {
    const raw = new TextDecoder().decode(bytes);
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
    return { doc: decoded.right, revision: revisionOf(raw), path };
  };

  /**
   * Commit the full live map as the next sequential authority generation.
   * Refuses accidental shrinkage: names present in the previous generation
   * must still be present unless listed in `explicitlyRemoved`.
   */
  const assertAuthorityWritable = (): void => {
    if (authorityBlocked !== undefined) {
      throw new CanvasError({
        message: `canvas authority blocked: ${authorityBlocked}`,
      });
    }
  };

  const commitLiveAuthorityGeneration = async (
    explicitlyRemoved: ReadonlySet<string> = new Set(),
  ): Promise<void> =>
    withAuthorityMutex(async () => {
      assertAuthorityWritable();
      const authRoot = canvasAuthorityRoot();
      // Fail closed: a corrupt store must not look "absent" and allow shrink.
      const previous = await loadAuthoritySnapshot(authRoot);
      if (previous !== undefined) {
        for (const name of previous.documents.keys()) {
          if (!liveAuthority.has(name) && !explicitlyRemoved.has(name)) {
            throw new CanvasError({
              message:
                `refusing authority commit that would drop canvas "${name}" without remove(); ` +
                `live map is incomplete relative to generation ${previous.pointer.generation}`,
            });
          }
        }
      }

      const documents = new Map<string, Uint8Array>();
      for (const [name, entry] of liveAuthority) {
        documents.set(name, textEncoder.encode(serializeCanvas(entry.doc)));
      }
      const nextGeneration = (authorityGeneration + 1n).toString();
      await commitAuthorityGeneration(
        {
          generation: nextGeneration,
          createdAt: new Date().toISOString(),
          documents,
        },
        authRoot,
      );
      authorityGeneration = BigInt(nextGeneration);
    });

  const virtualPath = (name: CanvasName): string =>
    canvasDocumentPathIn(canvasesDir(), name);

  /** True when objects exist without a usable current.json pointer. */
  const authorityOrphansPresent = async (authRoot: string): Promise<boolean> => {
    for (const sub of ["documents", "manifests"] as const) {
      try {
        const entries = await readdir(join(authRoot, sub));
        if (entries.some((name) => !name.endsWith(".tmp"))) return true;
      } catch {
        // missing dir is fine
      }
    }
    return false;
  };

  /**
   * Load one full generation into the live map. Any invalid name or semantic
   * document fails the whole generation — never partial skip.
   */
  const loadSnapshotIntoLive = (
    root: string,
    snapshot: NonNullable<Awaited<ReturnType<typeof loadAuthoritySnapshot>>>,
  ): void => {
    const next = new Map<string, LiveAuthority>();
    for (const [rawName, bytes] of snapshot.documents) {
      let name: CanvasName;
      try {
        name = canvasNameFrom(rawName);
      } catch (error) {
        throw new CanvasError({
          message: `authority generation ${snapshot.pointer.generation} unusable: invalid name "${rawName}" (${
            error instanceof Error ? error.message : String(error)
          })`,
        });
      }
      try {
        next.set(name, decodeDocumentBytes(name, virtualPath(name), bytes));
      } catch (error) {
        throw new CanvasError({
          message: `authority generation ${snapshot.pointer.generation} unusable: document "${name}" failed (${
            error instanceof Error ? error.message : String(error)
          })`,
        });
      }
    }
    liveAuthority.clear();
    for (const [name, entry] of next) {
      liveAuthority.set(name, entry);
    }
    authorityGeneration = BigInt(snapshot.pointer.generation);
  };

  const bootstrapLiveAuthority = async (): Promise<void> => {
    if (bootstrapped) return;
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      // Sidecar root only — not a document store.
      await ensureCanvasesDir();
      const authRoot = canvasAuthorityRoot();
      let snapshot: Awaited<ReturnType<typeof loadAuthoritySnapshot>>;
      try {
        snapshot = await loadAuthoritySnapshot(authRoot);
      } catch (error) {
        const detail =
          error instanceof CanvasAuthorityError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        authorityBlocked = `corrupt authority store: ${detail}`;
        liveAuthority.clear();
        authorityGeneration = 0n;
        bootstrapped = true;
        return;
      }
      if (snapshot === undefined) {
        if (await authorityOrphansPresent(authRoot)) {
          authorityBlocked =
            "authority pointer missing but store objects present; recovery required";
          liveAuthority.clear();
          authorityGeneration = 0n;
          bootstrapped = true;
          return;
        }
        authorityBlocked = undefined;
        authorityGeneration = 0n;
        bootstrapped = true;
        return;
      }
      try {
        loadSnapshotIntoLive(canvasesDir(), snapshot);
        authorityBlocked = undefined;
      } catch (error) {
        authorityBlocked =
          error instanceof CanvasError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        liveAuthority.clear();
        authorityGeneration = 0n;
      }
      bootstrapped = true;
    })();
    try {
      await bootstrapPromise;
    } finally {
      bootstrapPromise = undefined;
    }
  };

  const requireLive = async (name: CanvasName): Promise<LiveAuthority> => {
    await bootstrapLiveAuthority();
    assertAuthorityWritable();
    const entry = liveAuthority.get(name);
    if (!entry) {
      throw new CanvasError({
        message: `canvas "${name}" is not in live authority (missing or never admitted)`,
      });
    }
    return entry;
  };

  const list: Effect.Effect<ReadonlyArray<CanvasSummary>, CanvasError> = Effect.tryPromise({
    try: async () => {
      await bootstrapLiveAuthority();
      const now = new Date().toISOString();
      return [...liveAuthority.entries()]
        .map(([name, entry]) => ({
          name,
          path: entry.path,
          modifiedAt: now,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    catch: toCanvasError,
  });

  const read = (name: string): Effect.Effect<CanvasReadResult, CanvasError> =>
    Effect.tryPromise({
      try: async () => {
        const canonicalName = canvasNameFrom(name);
        const entry = await requireLive(canonicalName);
        return {
          name: canonicalName,
          doc: entry.doc,
          revision: entry.revision,
          path: entry.path,
        };
      },
      catch: toCanvasError,
    });

  // Validates, applies mirror law, updates live map, commits full authority generation.
  const write = (
    name: string,
    doc: CanvasDoc,
    expectedRevision?: string,
  ): Effect.Effect<CanvasWriteResult, CanvasError> =>
    Effect.tryPromise({
      try: () =>
        withCanvasMutex(canvasFileName(canvasNameFrom(name)), async () => {
          await bootstrapLiveAuthority();
          assertAuthorityWritable();
          const canonicalName = canvasNameFrom(name);
          const decoded = decodeCanvasDoc(doc);
          if (Either.isLeft(decoded)) {
            throw new CanvasError({
              message: `cannot write ${canvasFileName(canonicalName)}: ${decoded.left.message}`,
            });
          }

          const nextDoc = applyMirrorLaw(decoded.right);
          const serialized = serializeCanvas(nextDoc);
          const revision = revisionOf(serialized);
          const path = virtualPath(canonicalName);

          if (expectedRevision !== undefined) {
            const current = liveAuthority.get(canonicalName);
            if (current === undefined || current.revision !== expectedRevision) {
              throw new CanvasError({
                message: `${canvasFileName(canonicalName)} revision conflict; reload before saving`,
              });
            }
          }

          const previous = liveAuthority.get(canonicalName);
          liveAuthority.set(canonicalName, {
            doc: nextDoc,
            revision,
            path,
          });
          try {
            await commitLiveAuthorityGeneration();
          } catch (error) {
            if (previous === undefined) liveAuthority.delete(canonicalName);
            else liveAuthority.set(canonicalName, previous);
            throw error;
          }
          notifyListeners(canonicalName);
          return { revision };
        }),
      catch: toCanvasError,
    });

  const mutate = (name: string, fn: (doc: CanvasDoc) => CanvasDoc): Effect.Effect<void, CanvasError> =>
    Effect.tryPromise({
      try: () =>
        withCanvasMutex(canvasFileName(canvasNameFrom(name)), async () => {
          await bootstrapLiveAuthority();
          const canonicalName = canvasNameFrom(name);
          const current = await requireLive(canonicalName);
          const next = fn(current.doc);

          const decoded = decodeCanvasDoc(next);
          if (Either.isLeft(decoded)) {
            throw new CanvasError({
              message: `cannot mutate ${canvasFileName(canonicalName)}: ${decoded.left.message}`,
            });
          }

          const nextDoc = applyMirrorLaw(decoded.right);
          const revision = revisionOf(serializeCanvas(nextDoc));
          const previous = current;
          liveAuthority.set(canonicalName, {
            doc: nextDoc,
            revision,
            path: current.path,
          });
          try {
            await commitLiveAuthorityGeneration();
          } catch (error) {
            liveAuthority.set(canonicalName, previous);
            throw error;
          }
          notifyListeners(canonicalName);
        }),
      catch: toCanvasError,
    });

  const sanitizeName = (name: string): Effect.Effect<CanvasName, CanvasError> =>
    Effect.try({ try: () => canvasNameFrom(name), catch: toCanvasError });

  const create = (name: string): Effect.Effect<CanvasReadResult, CanvasError> =>
    Effect.tryPromise({
      try: async () => {
        const sanitized = canvasNameFrom(name);
        return withCanvasMutex(canvasFileName(sanitized), async () => {
          await bootstrapLiveAuthority();
          assertAuthorityWritable();
          if (liveAuthority.has(sanitized)) {
            throw new CanvasError({ message: `canvas "${sanitized}" already exists` });
          }
          const doc = applyMirrorLaw({ nodes: [], edges: [] });
          const serialized = serializeCanvas(doc);
          const revision = revisionOf(serialized);
          const path = virtualPath(sanitized);
          const nextEntry: LiveAuthority = { doc, revision, path };
          liveAuthority.set(sanitized, nextEntry);
          try {
            await commitLiveAuthorityGeneration();
          } catch (error) {
            liveAuthority.delete(sanitized);
            throw error;
          }
          notifyListeners(sanitized);
          return { name: sanitized, doc, revision, path };
        });
      },
      catch: toCanvasError,
    });

  const remove = (name: string): Effect.Effect<{ name: string }, CanvasError> =>
    Effect.gen(function* () {
      const sanitized = yield* sanitizeName(name);

      yield* Effect.tryPromise({
        try: () =>
          withCanvasMutex(canvasFileName(sanitized), async () => {
            await bootstrapLiveAuthority();
            assertAuthorityWritable();
            const previous = liveAuthority.get(sanitized);
            if (previous === undefined) {
              throw new CanvasError({ message: `canvas "${sanitized}" does not exist` });
            }

            liveAuthority.delete(sanitized);
            try {
              await commitLiveAuthorityGeneration(new Set([sanitized]));
            } catch (error) {
              liveAuthority.set(sanitized, previous);
              throw error;
            }
            // Best-effort agent sidecar cleanup (digest/svg).
            try {
              const root = await ensureCanvasesDir();
              for (const suffix of SIDECAR_SUFFIXES) {
                await rm(canvasSidecarPathIn(root, sanitized, suffix), {
                  force: true,
                }).catch(() => undefined);
              }
            } catch {
              // ignore
            }
            notifyListeners(sanitized);
          }),
        catch: toCanvasError,
      });

      return { name: sanitized };
    });

  const ensureSeed: Effect.Effect<void, CanvasError> = Effect.gen(function* () {
    const visible = yield* list;
    if (visible.length === 0) {
      yield* create(SEED_CANVAS_NAME);
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

  const start = (): void => {
    void bootstrapLiveAuthority().catch((error) => {
      console.error("[canvases] live authority bootstrap failed:", error);
    });
  };

  const subscribeChanges = (listener: (name: string) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const liveDocuments = (): Effect.Effect<
    ReadonlyArray<{ readonly canvasName: string; readonly doc: CanvasDoc }>,
    CanvasError
  > =>
    Effect.tryPromise({
      try: async () => {
        await bootstrapLiveAuthority();
        return [...liveAuthority.entries()].map(([canvasName, entry]) => ({
          canvasName,
          doc: entry.doc,
        }));
      },
      catch: toCanvasError,
    });

  /**
   * Projection install: replace the live map with a fully-validated document
   * set and commit one full-map generation. No disk re-read.
   */
  const replaceLiveAuthorityDocuments = (
    documents: ReadonlyMap<string, CanvasDoc>,
  ): Effect.Effect<void, CanvasError> =>
    Effect.tryPromise({
      try: async () => {
        await bootstrapLiveAuthority();
        assertAuthorityWritable();
        const previous = new Map(liveAuthority);
        const previousGeneration = authorityGeneration;
        const next = new Map<string, LiveAuthority>();
        const removed = new Set<string>();
        const changed: CanvasName[] = [];

        for (const [rawName, doc] of documents) {
          const name = canvasNameFrom(rawName);
          const decoded = decodeCanvasDoc(doc);
          if (Either.isLeft(decoded)) {
            throw new CanvasError({
              message: `projection document "${name}" failed validation: ${decoded.left.message}`,
            });
          }
          const nextDoc = applyMirrorLaw(decoded.right);
          const serialized = serializeCanvas(nextDoc);
          next.set(name, {
            doc: nextDoc,
            revision: revisionOf(serialized),
            path: virtualPath(name),
          });
          changed.push(name);
        }
        for (const name of liveAuthority.keys()) {
          if (!next.has(name)) {
            removed.add(name);
            changed.push(name as CanvasName);
          }
        }

        liveAuthority.clear();
        for (const [name, entry] of next) {
          liveAuthority.set(name, entry);
        }
        try {
          await commitLiveAuthorityGeneration(removed);
        } catch (error) {
          liveAuthority.clear();
          for (const [name, entry] of previous) {
            liveAuthority.set(name, entry);
          }
          authorityGeneration = previousGeneration;
          throw error;
        }
        for (const name of changed) {
          notifyListeners(name as CanvasName);
        }
      },
      catch: toCanvasError,
    });

  return CanvasesService.of({
    doctor: Effect.sync(() => {
      if (authorityBlocked !== undefined) {
        return {
          id: "canvases",
          label: "Canvas Documents",
          status: "error" as const,
          detail: authorityBlocked,
        };
      }
      return {
        id: "canvases",
        label: "Canvas Documents",
        status: "ok" as const,
        detail: `${canvasAuthorityRoot()} · gen ${authorityGeneration.toString()}`,
      };
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
    liveDocuments,
    replaceLiveAuthorityDocuments,
  });
});
