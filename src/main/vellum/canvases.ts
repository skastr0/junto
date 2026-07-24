import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
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
 * Sidecars are not product durability — authority is. No dual-path
 * `.canvas` file is required (or written) for sidecar publication.
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
// Durable store: canvas-authority-v1 only (`current.json` + content-addressed
// objects). Legacy ~/.vellum/canvases is import-only (one-shot on first boot
// when no pointer exists, or promote missing names once). External .canvas
// edits never re-admit into live authority.
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
    // document. Concurrent app mutates serialize; external disk bytes are never
    // re-admitted as the base document.
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
    // Bootstraps the live authority map from disk once (idempotent).
    readonly start: () => void;
    readonly subscribeChanges: (listener: (name: string) => void) => () => void;
    /** Snapshot of live authority docs for process-bind caller resolution. */
    readonly liveDocuments: () => Effect.Effect<
      ReadonlyArray<{ readonly canvasName: string; readonly doc: CanvasDoc }>,
      CanvasError
    >;
    /**
     * Command Center projection install (Remote pull): re-admit installed
     * disk bytes into live authority and drop names no longer present.
     * Not a general external-edit path — only the pull/install plane calls this.
     */
    readonly replaceLiveAuthorityFromInstall: (
      installedNames: ReadonlyArray<string>,
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

  // Live operator-intent authority. Disk durability is separate; external
  // edits to .canvas files never update this map after bootstrap.
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
  const commitLiveAuthorityGeneration = async (
    explicitlyRemoved: ReadonlySet<string> = new Set(),
  ): Promise<void> =>
    withAuthorityMutex(async () => {
      const authRoot = canvasAuthorityRoot();
      const previous = await loadAuthoritySnapshot(authRoot).catch(() => undefined);
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

  const loadSnapshotIntoLive = (
    root: string,
    snapshot: NonNullable<Awaited<ReturnType<typeof loadAuthoritySnapshot>>>,
  ): void => {
    liveAuthority.clear();
    for (const [rawName, bytes] of snapshot.documents) {
      let name: CanvasName;
      try {
        name = canvasNameFrom(rawName);
      } catch {
        console.error(
          `[canvases] authority document skipped (invalid name): ${rawName}`,
        );
        continue;
      }
      try {
        const entry = decodeDocumentBytes(name, virtualPath(name), bytes);
        liveAuthority.set(name, entry);
      } catch (error) {
        console.error(`[canvases] authority document skipped (${name}):`, error);
      }
    }
    authorityGeneration = BigInt(snapshot.pointer.generation);
  };

  /** Read legacy .canvas files once (import only — not live dual-path). */
  const readLegacyCanvasFiles = async (
    root: string,
  ): Promise<Map<string, Uint8Array>> => {
    const out = new Map<string, Uint8Array>();
    let files: string[] = [];
    try {
      files = (await readdir(root)).filter((file) => file.endsWith(".canvas"));
    } catch {
      return out;
    }
    for (const file of files) {
      if (file.includes(".pre-") || file.includes(".bak")) continue;
      let name: CanvasName;
      try {
        name = canvasNameFrom(basename(file, ".canvas"));
      } catch {
        continue;
      }
      try {
        const path = canvasDocumentPathIn(root, name);
        await assertRegularOrMissing(path);
        out.set(name, new Uint8Array(await readFile(path)));
      } catch {
        // skip
      }
    }
    return out;
  };

  /**
   * One-shot import: commit legacy (and any already-live) documents into
   * authority, then load. Used when no pointer exists, or pointer is missing
   * names that still exist as legacy import candidates.
   */
  const importLegacyIntoAuthority = async (root: string): Promise<void> => {
    const legacy = await readLegacyCanvasFiles(root);
    const documents = new Map<string, Uint8Array>();
    for (const [name, entry] of liveAuthority) {
      documents.set(name, textEncoder.encode(serializeCanvas(entry.doc)));
    }
    for (const [name, bytes] of legacy) {
      if (!documents.has(name)) documents.set(name, bytes);
    }
    if (documents.size === 0) {
      authorityGeneration = 0n;
      return;
    }
    const nextGeneration = (authorityGeneration + 1n).toString();
    const snap = await commitAuthorityGeneration(
      {
        generation: nextGeneration,
        createdAt: new Date().toISOString(),
        documents,
      },
      canvasAuthorityRoot(),
    );
    loadSnapshotIntoLive(root, snap);
  };

  const bootstrapFromAuthorityStore = async (
    root: string,
  ): Promise<"loaded" | "absent" | "corrupt"> => {
    let snapshot: Awaited<ReturnType<typeof loadAuthoritySnapshot>>;
    try {
      snapshot = await loadAuthoritySnapshot(canvasAuthorityRoot());
    } catch (error) {
      console.error(
        "[canvases] authority store unreadable (corrupt); will attempt legacy import:",
        error,
      );
      return "corrupt";
    }
    if (snapshot === undefined) return "absent";
    loadSnapshotIntoLive(root, snapshot);
    return "loaded";
  };

  const bootstrapLiveAuthority = async (): Promise<void> => {
    if (bootstrapped) return;
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      const root = await ensureCanvasesDir();
      const status = await bootstrapFromAuthorityStore(root);
      // One-shot import only when there is no usable pointer. After that,
      // authority is sole SoT — drop-in legacy .canvas files never re-admit.
      if (status === "absent" || status === "corrupt") {
        await importLegacyIntoAuthority(root);
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
            // Best-effort cleanup of legacy/export sidecars — not product durability.
            try {
              const root = await ensureCanvasesDir();
              await rm(canvasDocumentPathIn(root, sanitized), { force: true });
              for (const suffix of SIDECAR_SUFFIXES) {
                await rm(canvasSidecarPathIn(root, sanitized, suffix), {
                  force: true,
                }).catch(() => undefined);
              }
            } catch {
              // ignore export-plane cleanup
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

  // Bootstrap live authority once; do not watch for external authoring.
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
   * Remote pull / projection install: replace live authority with the
   * installed set. Names not in installedNames are dropped (CC deleted them).
   * Each installed name is re-decoded from disk under its mutex.
   */
  const replaceLiveAuthorityFromInstall = (
    installedNames: ReadonlyArray<string>,
  ): Effect.Effect<void, CanvasError> =>
    Effect.tryPromise({
      try: async () => {
        await bootstrapLiveAuthority();
        const root = await ensureCanvasesDir();
        const previous = new Map(liveAuthority);
        const keep = new Set<string>();
        const changed: CanvasName[] = [];
        const removed = new Set<string>();
        for (const rawName of installedNames) {
          const name = canvasNameFrom(rawName);
          keep.add(name);
          await withCanvasMutex(canvasFileName(name), async () => {
            const path = canvasDocumentPathIn(root, name);
            await assertRegularOrMissing(path);
            const raw = await readFile(path, "utf8");
            const entry = decodeDocumentBytes(
              name,
              path,
              textEncoder.encode(raw),
            );
            liveAuthority.set(name, entry);
            changed.push(name);
          });
        }
        for (const name of [...liveAuthority.keys()]) {
          if (keep.has(name)) continue;
          liveAuthority.delete(name);
          removed.add(name);
          changed.push(name as CanvasName);
        }
        try {
          await commitLiveAuthorityGeneration(removed);
        } catch (error) {
          liveAuthority.clear();
          for (const [name, entry] of previous) {
            liveAuthority.set(name, entry);
          }
          throw error;
        }
        for (const name of changed) {
          notifyListeners(name);
        }
      },
      catch: toCanvasError,
    });

  return CanvasesService.of({
    doctor: Effect.succeed({
      id: "canvases",
      label: "Canvas Documents",
      status: "ok",
      detail: canvasAuthorityRoot(),
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
    replaceLiveAuthorityFromInstall,
  });
});
