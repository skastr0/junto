import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  FILES_COUNT_CAP,
  parseFilePath,
  type FileEntry,
  type FilesCount,
  type FileImported,
  type FilePath,
  type FileRead,
  type FilesChanged,
  type FilesNodeRef,
  type FilesResult,
  type FilesRoot,
  type FilesSearchResult,
  type FileStamp,
} from "@shared/files";
import { isThisMachine } from "@shared/machine-identity";
import {
  createAt,
  fileForBytes,
  importInto,
  listDir,
  moveAt,
  ok,
  openableAt,
  readFileAt,
  realRoot,
  refused,
  renameAt,
  revealableAt,
  trashAt,
  writeFileAt,
  type Scope,
} from "./fs-ops";
import { COMPACT_AFTER, NameIndexBuilder, type MatchSet, type NameIndex } from "./name-index";
import { gitIgnored, gitNames, isGitRoot, walkNames, type NameSink } from "./sources";
import { watchRoot, type Timers, type WatchBatch, type WatchFactory } from "./watcher";

/**
 * The Files service in main (0.11, F2). Stateless per call for the
 * filesystem: every call reads the node fresh, checks it is a Files node on
 * this machine, and resolves its root's realpath (`fs-ops.ts` scopes the
 * target). State is only what serving a window needs:
 *
 * - a session per (window, node) from `open` to `close`, which receives the
 *   node's changes and arms its `junto-file:` bytes;
 * - a holder per root realpath, shared by every session on that root, with
 *   one watcher and, from the first search, one name index. The last session
 *   to leave drops both.
 */

/** What main reads off a node: only a Files node answers. */
export type FilesNodeFacts = { readonly host: string; readonly root: string };

/** The names a root's index is built from; swapped in tests. */
export type NameSources = {
  readonly isGitRoot: (root: string, signal: AbortSignal) => Promise<boolean>;
  readonly gitNames: (root: string, sink: NameSink, signal: AbortSignal) => Promise<void>;
  readonly walkNames: (root: string, sink: NameSink, signal: AbortSignal, cap?: number) => Promise<void>;
  readonly gitIgnored: (root: string, paths: ReadonlyArray<string>, signal: AbortSignal) => Promise<ReadonlySet<string>>;
};

export type FilesServiceDeps = {
  readonly node: (ref: FilesNodeRef) => Promise<FilesNodeFacts | undefined>;
  readonly machineName: () => Promise<string>;
  /** Folders refused inside any root (Junto's own home), as realpaths. */
  readonly deny: () => Promise<ReadonlyArray<string>>;
  readonly trash: (absolute: string) => Promise<void>;
  /** `shell.openPath`: answers "" on success, else the reason. */
  readonly openPath: (absolute: string) => Promise<string>;
  readonly reveal: (absolute: string) => void;
  /** Push a change to a window, by its subscriber id. */
  readonly send: (subscriber: number, event: FilesChanged) => void;
  readonly watch?: WatchFactory;
  readonly timers?: Timers;
  readonly names?: NameSources;
};

const liveNames: NameSources = { isGitRoot, gitNames, walkNames, gitIgnored };

type Session = { readonly subscriber: number; readonly ref: FilesNodeRef; root: string };

type Holder = {
  readonly root: string;
  readonly sessions: Set<string>;
  readonly watcher: { readonly close: () => void };
  readonly abort: AbortController;
  repo?: boolean;
  index?: NameIndex;
  building?: Promise<NameIndex>;
  /** Paths seen while a build ran, applied once it lands. */
  heldDuringBuild?: string[];
  stale: boolean;
  /** Deltas apply one batch at a time. */
  deltas: Promise<void>;
  readonly matchSets: Map<string, MatchSet>;
};

const sessionKey = (subscriber: number, node: string): string => `${String(subscriber)}\0${node}`;

export type FilesService = ReturnType<typeof makeFilesService>;

export const makeFilesService = (deps: FilesServiceDeps) => {
  const names = deps.names ?? liveNames;
  const sessions = new Map<string, Session>();
  const holders = new Map<string, Holder>();
  const latestSeq = new Map<string, number>();

  /** The node's root realpath, or why the node is not served here. */
  const rootOf = async (ref: FilesNodeRef): Promise<FilesResult<string>> => {
    const [facts, machine] = await Promise.all([deps.node(ref), deps.machineName()]);
    if (facts === undefined) return refused("no-node");
    if (!isThisMachine(facts.host, machine)) return refused("elsewhere");
    return realRoot(facts.root);
  };

  const withRoot = async <A>(
    ref: FilesNodeRef,
    work: (scope: Scope) => Promise<FilesResult<A>>,
  ): Promise<FilesResult<A>> => {
    const [root, deny] = await Promise.all([rootOf(ref), deps.deny()]);
    return root.ok ? work({ root: root.value, deny }) : root;
  };

  const sendTo = (holder: Holder, event: (node: FilesNodeRef["node"]) => FilesChanged): void => {
    for (const key of holder.sessions) {
      const session = sessions.get(key);
      if (session !== undefined) deps.send(session.subscriber, event(session.ref.node));
    }
  };

  const dropHolder = (holder: Holder): void => {
    holder.abort.abort();
    holder.watcher.close();
    holders.delete(holder.root);
  };

  const release = (key: string): void => {
    const session = sessions.get(key);
    if (session === undefined) return;
    sessions.delete(key);
    latestSeq.delete(key);
    const holder = holders.get(session.root);
    if (holder === undefined) return;
    holder.sessions.delete(key);
    holder.matchSets.delete(key);
    if (holder.sessions.size === 0) dropHolder(holder);
  };

  const buildIndex = (holder: Holder): Promise<NameIndex> => {
    const build = async (): Promise<NameIndex> => {
      holder.heldDuringBuild = [];
      const signal = holder.abort.signal;
      holder.repo ??= await names.isGitRoot(holder.root, signal);
      let builder = new NameIndexBuilder();
      const sink: NameSink = (batch) => builder.add(batch);
      if (holder.repo) {
        try {
          await names.gitNames(holder.root, sink, signal);
        } catch (cause) {
          console.error("[files] git ls-files failed, walking instead", cause);
          builder = new NameIndexBuilder();
          await names.walkNames(holder.root, sink, signal);
        }
      } else {
        await names.walkNames(holder.root, sink, signal);
      }
      const index = await builder.finish();
      holder.index = index;
      holder.stale = false;
      holder.matchSets.clear();
      const held = holder.heldDuringBuild;
      holder.heldDuringBuild = undefined;
      if (held.length > 0) await applyDeltas(holder, index, held);
      return index;
    };
    const building = build().finally(() => {
      if (holder.building === building) holder.building = undefined;
    });
    holder.building = building;
    return building;
  };

  const ensureIndex = (holder: Holder): Promise<NameIndex> => {
    if (holder.building !== undefined) return holder.building;
    if (holder.index !== undefined && !holder.stale) return Promise.resolve(holder.index);
    return buildIndex(holder);
  };

  /** Fold one batch of changed paths into a built index. A folder that appeared is walked; one that went is swept. */
  const applyDeltas = async (holder: Holder, index: NameIndex, paths: ReadonlyArray<string>): Promise<void> => {
    const signal = holder.abort.signal;
    const added: string[] = [];
    for (const path of paths) {
      if (signal.aborted) return;
      const info = await lstat(join(holder.root, path)).catch(() => undefined);
      if (info === undefined) {
        if (index.has(path)) index.remove(path);
        else index.removeUnder(path);
      } else if (info.isDirectory()) {
        await names.walkNames(join(holder.root, path), (batch) => {
          for (const name of batch) added.push(`${path}/${name}`);
        }, signal);
      } else if (!index.has(path)) {
        added.push(path);
      }
    }
    const ignored = holder.repo === true ? await names.gitIgnored(holder.root, added, signal) : new Set<string>();
    for (const path of added) if (!ignored.has(path)) index.add(path);
    if (index.drift > COMPACT_AFTER) holder.stale = true;
  };

  const onBatch = (holder: Holder, batch: WatchBatch): void => {
    if (batch.kind === "lost") {
      sendTo(holder, (node) => ({ node, kind: "closed", error: "root-missing" }));
      for (const key of [...holder.sessions]) release(key);
      dropHolder(holder);
      return;
    }
    if (batch.kind === "burst") {
      holder.stale = true;
      sendTo(holder, (node) => ({ node, kind: "reset" }));
      return;
    }
    const paths = batch.paths.flatMap((raw) => {
      const path = parseFilePath(raw);
      return path === undefined ? [] : [path];
    });
    if (paths.length === 0) return;
    sendTo(holder, (node) => ({ node, kind: "paths", paths }));
    if (holder.heldDuringBuild !== undefined) {
      holder.heldDuringBuild.push(...paths);
      return;
    }
    const index = holder.index;
    if (index === undefined || holder.stale) return;
    holder.deltas = holder.deltas
      .then(() => applyDeltas(holder, index, paths))
      .catch((cause: unknown) => {
        console.error("[files] index delta failed; rebuilding on next search", cause);
        holder.stale = true;
      });
  };

  /** Cards on the same unheld root share one count. */
  const counting = new Map<string, Promise<FilesCount>>();

  /** Count names without keeping them: one git ls-files, or a walk that stops at the cap. */
  const countOnce = async (root: string): Promise<FilesCount> => {
    const signal = new AbortController().signal;
    let files = 0;
    const sink: NameSink = (batch) => {
      files += batch.length;
    };
    if (await names.isGitRoot(root, signal)) {
      try {
        await names.gitNames(root, sink, signal);
        return { files, capped: false };
      } catch (cause) {
        console.error("[files] git ls-files failed, walking instead", cause);
        files = 0;
      }
    }
    await names.walkNames(root, sink, signal, FILES_COUNT_CAP);
    return { files, capped: files >= FILES_COUNT_CAP };
  };

  const holderFor = (root: string): Holder => {
    const existing = holders.get(root);
    if (existing !== undefined) return existing;
    let holder: Holder | undefined;
    const watcher = watchRoot(root, (batch) => {
      if (holder !== undefined) onBatch(holder, batch);
    }, deps.watch, deps.timers);
    holder = {
      root,
      sessions: new Set(),
      watcher,
      abort: new AbortController(),
      stale: false,
      deltas: Promise.resolve(),
      matchSets: new Map(),
    };
    holders.set(root, holder);
    return holder;
  };

  /** Hold `root` for a window's session on a node, moving the session when the node's root changed. */
  const hold = (subscriber: number, ref: FilesNodeRef, root: string): Holder => {
    const key = sessionKey(subscriber, ref.node);
    const current = sessions.get(key);
    if (current !== undefined && current.root !== root) release(key);
    const holder = holderFor(root);
    holder.sessions.add(key);
    if (!sessions.has(key)) sessions.set(key, { subscriber, ref, root });
    return holder;
  };

  return {
    open: async (subscriber: number, ref: FilesNodeRef): Promise<FilesResult<FilesRoot>> => {
      const root = await rootOf(ref);
      if (!root.ok) {
        release(sessionKey(subscriber, ref.node));
        return root;
      }
      const holder = hold(subscriber, ref, root.value);
      holder.repo ??= await names.isGitRoot(root.value, holder.abort.signal).catch(() => false);
      return ok({ name: basename(root.value), repo: holder.repo });
    },

    close: (subscriber: number, ref: FilesNodeRef): FilesResult<null> => {
      release(sessionKey(subscriber, ref.node));
      return ok(null);
    },

    /** A window went away: every session it held. */
    closeSubscriber: (subscriber: number): void => {
      for (const [key, session] of [...sessions]) if (session.subscriber === subscriber) release(key);
    },

    search: async (
      subscriber: number,
      ref: FilesNodeRef,
      query: string,
      seq: number,
    ): Promise<FilesResult<FilesSearchResult>> => {
      const key = sessionKey(subscriber, ref.node);
      latestSeq.set(key, Math.max(seq, latestSeq.get(key) ?? seq));
      const root = await rootOf(ref);
      if (!root.ok) return root;
      const holder = hold(subscriber, ref, root.value);
      const index = await ensureIndex(holder);
      await holder.deltas;
      if (latestSeq.get(key) !== seq) return ok({ kind: "superseded", query });
      if (query.trim() === "") return ok({ kind: "results", query, matches: [], total: index.size });
      const { matches, set } = index.search(query, holder.matchSets.get(key));
      holder.matchSets.set(key, set);
      return ok({ kind: "results", query, matches, total: index.size });
    },

    count: (ref: FilesNodeRef): Promise<FilesResult<FilesCount>> =>
      withRoot(ref, async ({ root }) => {
        const holder = holders.get(root);
        if (holder !== undefined) {
          const index = await ensureIndex(holder);
          await holder.deltas;
          return ok({ files: index.size, capped: false });
        }
        const running = counting.get(root);
        if (running !== undefined) return ok(await running);
        const once = countOnce(root).finally(() => counting.delete(root));
        counting.set(root, once);
        return ok(await once);
      }),

    list: (ref: FilesNodeRef, dir: FilePath): Promise<FilesResult<ReadonlyArray<FileEntry>>> =>
      withRoot(ref, (root) => listDir(root, dir)),
    read: (ref: FilesNodeRef, path: FilePath): Promise<FilesResult<FileRead>> =>
      withRoot(ref, (root) => readFileAt(root, path)),
    write: (ref: FilesNodeRef, path: FilePath, text: string, base: FileStamp): Promise<FilesResult<FileStamp>> =>
      withRoot(ref, (root) => writeFileAt(root, path, text, base)),
    create: (ref: FilesNodeRef, path: FilePath, dir: boolean): Promise<FilesResult<FileEntry>> =>
      withRoot(ref, (root) => createAt(root, path, dir)),
    rename: (ref: FilesNodeRef, path: FilePath, name: string): Promise<FilesResult<FilePath>> =>
      withRoot(ref, (root) => renameAt(root, path, name)),
    move: (ref: FilesNodeRef, path: FilePath, intoDir: FilePath): Promise<FilesResult<FilePath>> =>
      withRoot(ref, (root) => moveAt(root, path, intoDir)),
    trash: (ref: FilesNodeRef, path: FilePath): Promise<FilesResult<null>> =>
      withRoot(ref, (root) => trashAt(root, path, deps.trash)),
    import: (
      ref: FilesNodeRef,
      intoDir: FilePath,
      sources: ReadonlyArray<string>,
    ): Promise<FilesResult<ReadonlyArray<FileImported>>> => withRoot(ref, (root) => importInto(root, intoDir, sources)),
    openInDefaultApp: (ref: FilesNodeRef, path: FilePath): Promise<FilesResult<null>> =>
      withRoot(ref, async (root) => {
        const target = await openableAt(root, path);
        if (!target.ok) return target;
        const failure = await deps.openPath(target.value);
        if (failure !== "") console.error("[files] open in default app failed", failure);
        return failure === "" ? ok(null) : refused("failed");
      }),
    revealInFinder: (ref: FilesNodeRef, path: FilePath): Promise<FilesResult<null>> =>
      withRoot(ref, async (root) => {
        const target = await revealableAt(root, path);
        if (!target.ok) return target;
        deps.reveal(target.value);
        return ok(null);
      }),

    /**
     * The protocol's read: a regular file under a node some window opened,
     * by the node id as the URL carries it (lower case).
     */
    bytes: async (
      node: string,
      path: FilePath,
    ): Promise<FilesResult<{ readonly real: string; readonly size: number }>> => {
      const session = [...sessions.values()].find((held) => held.ref.node.toLowerCase() === node);
      if (session === undefined) return refused("no-node");
      return withRoot(session.ref, (root) => fileForBytes(root, path));
    },

    /** For tests and diagnostics: roots held now. */
    heldRoots: (): ReadonlyArray<string> => [...holders.keys()],
  };
};
