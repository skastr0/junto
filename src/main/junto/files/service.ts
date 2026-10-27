import type { FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import {
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
import { mainNameSources } from "./git-spawn";
import { makeRootIndex, type RootEvent, type RootIndex } from "./root-index";
import type { NameSources } from "./sources";
import type { Timers, WatchFactory } from "./watcher";

export type { NameSources } from "./sources";

/**
 * The Files service in main (0.11, F2). Stateless per call for the
 * filesystem: every call reads the node fresh, checks it is a Files node on
 * this machine, and resolves its root's realpath (`fs-ops.ts` scopes the
 * target). State is only what serving a window needs: a session per
 * (window, node) from `open` to `close`, which receives the node's changes
 * and arms its `junto-file:` bytes, and the kept counts of roots no window
 * holds.
 *
 * Each root's watcher and name index live in the root index
 * (`root-index.ts`), a worker thread in the app: main forwards opens,
 * searches and counts, and passes its events to the sessions on that root.
 */

/** What main reads off a node: only a Files node answers. */
export type FilesNodeFacts = { readonly host: string; readonly root: string };

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
  /** The root index; in process (with the three below) unless the app passes its worker. */
  readonly index?: (emit: (root: string, event: RootEvent) => void) => RootIndex;
  readonly watch?: WatchFactory;
  readonly timers?: Timers;
  readonly names?: NameSources;
  /** Wall-clock ms, for how long an unheld root's count is kept; swapped in tests. */
  readonly now?: () => number;
};

/** An unheld root has no watcher: its count is kept this long, then taken again. */
export const COUNT_KEEP_MS = 30_000;

type Session = { readonly subscriber: number; readonly ref: FilesNodeRef; root: string };

const sessionKey = (subscriber: number, node: string): string => `${String(subscriber)}\0${node}`;

export type FilesService = ReturnType<typeof makeFilesService>;

export const makeFilesService = (deps: FilesServiceDeps) => {
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const latestSeq = new Map<string, number>();
  /** Per session: the search the index is running, so only one waits there at a time. */
  const searching = new Map<string, Promise<void>>();
  /** Counts of roots no window holds: kept, so a canvas of Files cards never rescans on a render. */
  const counts = new Map<string, { readonly count: FilesCount; readonly at: number }>();

  const sessionsOn = (root: string): ReadonlyArray<string> =>
    [...sessions].flatMap(([key, session]) => (session.root === root ? [key] : []));

  const onEvent = (root: string, event: RootEvent): void => {
    const keys = sessionsOn(root);
    for (const key of keys) {
      const session = sessions.get(key)!;
      const node = session.ref.node;
      deps.send(
        session.subscriber,
        event.kind === "lost"
          ? { node, kind: "closed", error: "root-missing" }
          : event.kind === "reset"
            ? { node, kind: "reset" }
            : { node, kind: "paths", paths: event.paths },
      );
    }
    // The holder is gone with its watch: so are the sessions on it.
    if (event.kind === "lost") for (const key of keys) forget(key);
  };

  let settleIndex: (() => Promise<void>) | undefined;
  const index: RootIndex =
    deps.index?.(onEvent) ??
    (() => {
      const local = makeRootIndex({ names: deps.names ?? mainNameSources, emit: onEvent, watch: deps.watch, timers: deps.timers });
      settleIndex = local.settle;
      return local;
    })();

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

  /** Drop a session here only (its holder is already gone). */
  const forget = (key: string): void => {
    sessions.delete(key);
    latestSeq.delete(key);
    searching.delete(key);
  };

  const release = (key: string): void => {
    const session = sessions.get(key);
    if (session === undefined) return;
    forget(key);
    const { root } = session;
    index.release(root, key).then(
      (last) => {
        // The last count a card sees until the root is opened again.
        if (last !== undefined && sessionsOn(root).length === 0) counts.set(root, { count: last, at: now() });
      },
      (cause: unknown) => console.error("[files] index release failed", cause),
    );
  };

  /** Track a window's session on a node, moving it when the node's root changed. True when it is new. */
  const track = (subscriber: number, ref: FilesNodeRef, root: string): boolean => {
    const key = sessionKey(subscriber, ref.node);
    const current = sessions.get(key);
    if (current !== undefined && current.root === root) return false;
    if (current !== undefined) release(key);
    sessions.set(key, { subscriber, ref, root });
    counts.delete(root);
    return true;
  };

  return {
    open: async (subscriber: number, ref: FilesNodeRef): Promise<FilesResult<FilesRoot>> => {
      const root = await rootOf(ref);
      if (!root.ok) {
        release(sessionKey(subscriber, ref.node));
        return root;
      }
      track(subscriber, ref, root.value);
      const { repo } = await index.hold(root.value, sessionKey(subscriber, ref.node));
      return ok({ name: basename(root.value), repo });
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
      track(subscriber, ref, root.value);
      // One search per session in the index at a time: one that waited past
      // a newer keystroke answers superseded without running.
      const run = async (): Promise<FilesSearchResult> => {
        if (latestSeq.get(key) !== seq) return { kind: "superseded", query };
        let found;
        try {
          found = await index.search(root.value, key, query);
        } catch (cause) {
          // The worker stopped: the next call starts a fresh one and builds again.
          console.error("[files] index search failed; once more", cause);
          found = await index.search(root.value, key, query);
        }
        return { kind: "results", query, matches: found.matches, total: found.total };
      };
      const answer = (searching.get(key) ?? Promise.resolve()).then(run);
      searching.set(key, answer.then(() => undefined, () => undefined));
      const result = await answer;
      if (result.kind === "results" && latestSeq.get(key) !== seq) return ok({ kind: "superseded", query });
      return ok(result);
    },

    count: (ref: FilesNodeRef): Promise<FilesResult<FilesCount>> =>
      withRoot(ref, async ({ root }) => {
        if (sessionsOn(root).length > 0) return ok(await index.count(root));
        const known = counts.get(root);
        if (known !== undefined && now() - known.at < COUNT_KEEP_MS) return ok(known.count);
        const count = await index.count(root);
        // A root opened meanwhile counts from its index from now on.
        if (sessionsOn(root).length === 0) counts.set(root, { count, at: now() });
        return ok(count);
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
    heldRoots: (): ReadonlyArray<string> => [...new Set([...sessions.values()].map((session) => session.root))],

    /** Every rebuild and queued delta done (in-process index only): for tests and measurements. */
    settle: async (): Promise<void> => {
      await settleIndex?.();
    },
  };
};
