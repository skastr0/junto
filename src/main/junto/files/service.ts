import { lstat, type FileHandle } from "node:fs/promises";
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
import { inProcessEngine, type IndexEngine } from "./index-engine";
import { COMPACT_AFTER } from "./name-index";
import { gitIgnored, gitNames, isGitRoot, linkInside, walkNames, type NameSink } from "./sources";
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
 *
 * The index itself lives in the engine (a worker thread in the app): main
 * finds names and classifies changes, the engine builds and searches. Only
 * the first build is waited for; after that a stale index keeps answering
 * while its rebuild runs.
 */

/** What main reads off a node: only a Files node answers. */
export type FilesNodeFacts = { readonly host: string; readonly root: string };

/** The names a root's index is built from; swapped in tests. */
export type NameSources = {
  readonly isGitRoot: (root: string, signal: AbortSignal) => Promise<boolean>;
  readonly gitNames: (root: string, sink: NameSink, signal: AbortSignal) => Promise<void>;
  readonly walkNames: (root: string, sink: NameSink, signal: AbortSignal, cap?: number, within?: string) => Promise<void>;
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
  /** Where indexes are built and searched; in process unless the app passes its worker. */
  readonly engine?: IndexEngine;
  /** Wall-clock ms, for how long an unheld root's count is kept; swapped in tests. */
  readonly now?: () => number;
};

/** An unheld root has no watcher: its count is kept this long, then taken again. */
export const COUNT_KEEP_MS = 30_000;

const liveNames: NameSources = { isGitRoot, gitNames, walkNames, gitIgnored };

type Session = { readonly subscriber: number; readonly ref: FilesNodeRef; root: string };

type Holder = {
  readonly root: string;
  readonly sessions: Set<string>;
  readonly watcher: { readonly close: () => void };
  readonly abort: AbortController;
  repo?: boolean;
  /** The engine slot of the index that answers, once one is built. */
  slot?: number;
  size: number;
  drift: number;
  building?: Promise<void>;
  /** Paths seen while a build ran, applied once it lands. */
  heldDuringBuild?: string[];
  stale: boolean;
  /** Deltas apply one batch at a time. */
  deltas: Promise<void>;
  /** Paths waiting in `deltas`. */
  queued: number;
  /** Bursts seen: a build that saw one arrive mid-scan leaves the index stale. */
  bursts: number;
};

const sessionKey = (subscriber: number, node: string): string => `${String(subscriber)}\0${node}`;

export type FilesService = ReturnType<typeof makeFilesService>;

export const makeFilesService = (deps: FilesServiceDeps) => {
  const names = deps.names ?? liveNames;
  const engine = deps.engine ?? inProcessEngine();
  const now = deps.now ?? Date.now;
  let slots = 0;
  /** Per session: the search the engine is running, so only one waits there at a time. */
  const searching = new Map<string, Promise<void>>();
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

  /** A write that adds or removes names: the root's kept count is no longer true. */
  const changing = async <A>(ref: FilesNodeRef, work: (scope: Scope) => Promise<FilesResult<A>>): Promise<FilesResult<A>> =>
    withRoot(ref, async (scope) => {
      const result = await work(scope);
      if (result.ok) counts.delete(scope.root);
      return result;
    });

  const sendTo = (holder: Holder, event: (node: FilesNodeRef["node"]) => FilesChanged): void => {
    for (const key of holder.sessions) {
      const session = sessions.get(key);
      if (session !== undefined) deps.send(session.subscriber, event(session.ref.node));
    }
  };

  const dropHolder = (holder: Holder): void => {
    // The last count a card sees until the root is opened again.
    if (holder.slot !== undefined) {
      if (!holder.stale) counts.set(holder.root, { count: { files: holder.size, capped: false }, at: now() });
      engine.drop(holder.slot);
    }
    holder.abort.abort();
    holder.watcher.close();
    holders.delete(holder.root);
  };

  const release = (key: string): void => {
    const session = sessions.get(key);
    if (session === undefined) return;
    sessions.delete(key);
    latestSeq.delete(key);
    searching.delete(key);
    const holder = holders.get(session.root);
    if (holder === undefined) return;
    holder.sessions.delete(key);
    if (holder.slot !== undefined) engine.forget(holder.slot, key);
    if (holder.sessions.size === 0) dropHolder(holder);
  };

  /** Build into a fresh slot; the old one answers until this one lands. */
  const buildIndex = (holder: Holder): Promise<void> => {
    const build = async (): Promise<void> => {
      holder.heldDuringBuild = [];
      const bursts = holder.bursts;
      const signal = holder.abort.signal;
      holder.repo ??= await names.isGitRoot(holder.root, signal);
      const fresh = (): number => {
        slots += 1;
        engine.begin(slots);
        return slots;
      };
      let slot = fresh();
      const sinkInto = (into: number): NameSink => (batch) => engine.names(into, batch);
      let state;
      try {
        if (holder.repo) {
          try {
            await names.gitNames(holder.root, sinkInto(slot), signal);
          } catch (cause) {
            console.error("[files] git ls-files failed, walking instead", cause);
            engine.drop(slot);
            slot = fresh();
            await names.walkNames(holder.root, sinkInto(slot), signal);
          }
        } else {
          await names.walkNames(holder.root, sinkInto(slot), signal);
        }
        state = await engine.finish(slot);
      } catch (cause) {
        engine.drop(slot);
        throw cause;
      }
      if (signal.aborted) {
        engine.drop(slot);
        return;
      }
      const previous = holder.slot;
      holder.slot = slot;
      holder.size = state.size;
      holder.drift = state.drift;
      if (previous !== undefined) engine.drop(previous);
      // A burst keeps no paths: one that came mid-scan may be missing, so build again.
      holder.stale = holder.bursts !== bursts;
      const held = holder.heldDuringBuild;
      holder.heldDuringBuild = undefined;
      // On the chain, so no batch that came after the build interleaves with these.
      if (held.length > 0 && !holder.stale) {
        holder.queued += held.length;
        holder.deltas = holder.deltas
          .then(() => applyDeltas(holder, slot, held))
          .catch((cause: unknown) => {
            console.error("[files] index delta failed; rebuilding", cause);
            holder.stale = true;
          })
          .finally(() => {
            holder.queued -= held.length;
          });
      }
    };
    const building = build().finally(() => {
      if (holder.building === building) holder.building = undefined;
    });
    holder.building = building;
    return building;
  };

  /**
   * Ready to search: only the first build is awaited. After that the index
   * answers as it is: a stale one while its rebuild runs, a fresh one before
   * its queued deltas land (a check-ignore on a big repo can take seconds).
   */
  const ready = async (holder: Holder): Promise<void> => {
    if (holder.slot === undefined) {
      await (holder.building ?? buildIndex(holder));
      return;
    }
    if (holder.stale) {
      if (holder.building === undefined) {
        buildIndex(holder).catch((cause: unknown) => console.error("[files] index rebuild failed", cause));
      }
    }
  };

  /**
   * Fold one batch of changed paths into a built index. Ignored paths drop
   * first, deletes included (check-ignore matches by pattern, so a gone
   * `dist/` file needs no lookup). A folder that appeared is walked; the
   * engine sweeps folders that went. A stale index takes no deltas.
   */
  const applyDeltas = async (holder: Holder, slot: number, paths: ReadonlyArray<string>): Promise<void> => {
    const signal = holder.abort.signal;
    // A delta for an index a rebuild replaced: the new scan already has it.
    const current = (): boolean => !holder.stale && !signal.aborted && holder.slot === slot;
    if (!current()) return;
    const ignoredNow = holder.repo === true ? await names.gitIgnored(holder.root, paths, signal) : new Set<string>();
    const adds: string[] = [];
    const gone: string[] = [];
    const drop: string[] = [];
    const walked: string[] = [];
    for (const path of paths) {
      if (!current()) return;
      const info = await lstat(join(holder.root, path)).catch(() => undefined);
      if (ignoredNow.has(path)) {
        // Never added, never swept; gone, it leaves the index if it was there.
        if (info === undefined) drop.push(path);
      } else if (info === undefined) {
        gone.push(path);
      } else if (info.isDirectory()) {
        await names.walkNames(join(holder.root, path), (batch) => {
          for (const name of batch) walked.push(`${path}/${name}`);
        }, signal, undefined, holder.root);
      } else if (info.isSymbolicLink() && !(await linkInside(holder.root, join(holder.root, path)))) {
        // Points out of the root (or nowhere): no row that could only fail.
        drop.push(path);
      } else {
        adds.push(path);
      }
    }
    const ignoredWalked = holder.repo === true ? await names.gitIgnored(holder.root, walked, signal) : new Set<string>();
    if (!current()) return;
    for (const path of walked) if (!ignoredWalked.has(path)) adds.push(path);
    const outcome = await engine.apply(slot, { adds, gone, drop });
    if (holder.slot !== slot) return;
    holder.size = outcome.size;
    holder.drift = outcome.drift;
    if (outcome.overflow || outcome.drift > COMPACT_AFTER) holder.stale = true;
  };

  const onBatch = (holder: Holder, batch: WatchBatch): void => {
    if (batch.kind === "lost") {
      sendTo(holder, (node) => ({ node, kind: "closed", error: "root-missing" }));
      for (const key of [...holder.sessions]) release(key);
      dropHolder(holder);
      return;
    }
    if (batch.kind === "burst") {
      holder.bursts += 1;
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
    const slot = holder.slot;
    if (slot === undefined || holder.stale) return;
    // More queued than a rebuild costs: go stale now and drop the queue.
    if (holder.drift + holder.queued + paths.length > COMPACT_AFTER) {
      holder.stale = true;
      return;
    }
    holder.queued += paths.length;
    holder.deltas = holder.deltas
      .then(() => applyDeltas(holder, slot, paths))
      .catch((cause: unknown) => {
        console.error("[files] index delta failed; rebuilding on next search", cause);
        holder.stale = true;
      })
      .finally(() => {
        holder.queued -= paths.length;
      });
  };

  /**
   * Counts of roots no window holds: taken once, then kept, so a canvas of
   * Files cards never rescans on a render. Opening the root refreshes it
   * (from the index); cards on one root share one count in flight.
   */
  const counts = new Map<string, { readonly count: FilesCount; readonly at: number }>();
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
      queued: 0,
      bursts: 0,
      size: 0,
      drift: 0,
    };
    holders.set(root, holder);
    counts.delete(root);
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
      await ready(holder);
      // One search per session in the engine at a time: one that waited past
      // a newer keystroke answers superseded without running.
      const run = async (): Promise<FilesSearchResult> => {
        if (latestSeq.get(key) !== seq) return { kind: "superseded", query };
        let slot = holder.slot;
        if (slot === undefined) throw new Error("files index missing");
        try {
          const found = await engine.search(slot, key, query);
          return { kind: "results", query, matches: found.matches, total: found.total };
        } catch (cause) {
          // The engine lost the index (its worker stopped): build once more.
          console.error("[files] index search failed; rebuilding", cause);
          if (holder.slot === slot) holder.slot = undefined;
          await ready(holder);
          slot = holder.slot;
          if (slot === undefined) throw cause;
          const found = await engine.search(slot, key, query);
          return { kind: "results", query, matches: found.matches, total: found.total };
        }
      };
      const answer = (searching.get(key) ?? Promise.resolve()).then(run);
      searching.set(key, answer.then(() => undefined, () => undefined));
      const result = await answer;
      if (result.kind === "results" && latestSeq.get(key) !== seq) return ok({ kind: "superseded", query });
      return ok(result);
    },

    count: (ref: FilesNodeRef): Promise<FilesResult<FilesCount>> =>
      withRoot(ref, async ({ root }) => {
        const holder = holders.get(root);
        if (holder !== undefined) {
          await ready(holder);
          counts.delete(root);
          return ok({ files: holder.size, capped: false });
        }
        const known = counts.get(root);
        if (known !== undefined && now() - known.at < COUNT_KEEP_MS) return ok(known.count);
        const running = counting.get(root);
        if (running !== undefined) return ok(await running);
        const once = countOnce(root)
          .then((count) => {
            // A root opened meanwhile counts from its index from now on.
            if (!holders.has(root)) counts.set(root, { count, at: now() });
            return count;
          })
          .finally(() => counting.delete(root));
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
      changing(ref, (root) => createAt(root, path, dir)),
    rename: (ref: FilesNodeRef, path: FilePath, name: string): Promise<FilesResult<FilePath>> =>
      changing(ref, (root) => renameAt(root, path, name)),
    move: (ref: FilesNodeRef, path: FilePath, intoDir: FilePath): Promise<FilesResult<FilePath>> =>
      changing(ref, (root) => moveAt(root, path, intoDir)),
    trash: (ref: FilesNodeRef, path: FilePath): Promise<FilesResult<null>> =>
      changing(ref, (root) => trashAt(root, path, deps.trash)),
    import: (
      ref: FilesNodeRef,
      intoDir: FilePath,
      sources: ReadonlyArray<string>,
    ): Promise<FilesResult<ReadonlyArray<FileImported>>> => changing(ref, (root) => importInto(root, intoDir, sources)),
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
    ): Promise<FilesResult<{ readonly handle: FileHandle; readonly size: number }>> => {
      const session = [...sessions.values()].find((held) => held.ref.node.toLowerCase() === node);
      if (session === undefined) return refused("no-node");
      return withRoot(session.ref, (root) => fileForBytes(root, path));
    },

    /** For tests and diagnostics: roots held now. */
    heldRoots: (): ReadonlyArray<string> => [...holders.keys()],

    /** Every rebuild and queued delta done: for tests and measurements. */
    settle: async (): Promise<void> => {
      for (;;) {
        const busy = [...holders.values()].flatMap((holder) => [holder.building, holder.deltas]);
        if (busy.every((work) => work === undefined)) return;
        await Promise.all(busy.map((work) => work?.catch(() => undefined)));
        if ([...holders.values()].every((holder) => holder.building === undefined)) return;
      }
    },
  };
};
