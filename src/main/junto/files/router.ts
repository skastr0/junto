import { FILES_REMOTE_ENABLED } from "@shared/features";
import type {
  FileEntry, FilePath, FileRead, FilesChanged, FilesCount, FilesNodeRef, FilesResult, FilesRoot, FilesSearchResult, FileStamp,
} from "@shared/files";
import type { FilesRemote } from "./link-client";
import type { FilesNodeFacts, FilesService } from "./service";

/**
 * The window side of Files over SSH (0.12, X2): one router in main picks by
 * the node's `host`. This machine's node goes to the local service, as
 * before; another machine's goes to that machine's Junto over the link
 * (`link-client.ts`), which answers `unreachable` when there is no link.
 *
 * Open in default app, Reveal in Finder and imports are not routed: they act
 * on this machine, so the local service refuses another machine's node
 * `elsewhere` (imports cross with X3). With the feature off, or before the
 * link client is ready, every call goes to the local service, as in 0.11.
 */

/** What the router asks of the link client. */
export type FilesRemotePort = Pick<
  FilesRemote,
  "open" | "close" | "count" | "list" | "read" | "write" | "create" | "rename" | "move" | "trash" | "search" | "onChange"
>;

export type FilesRouterDeps = {
  readonly local: FilesService;
  /** The link client, once main has built it. */
  readonly remote: () => FilesRemotePort | undefined;
  readonly node: (ref: FilesNodeRef) => Promise<FilesNodeFacts | undefined>;
  readonly machineName: () => Promise<string>;
  /** A change to a window that has the node open. */
  readonly send: (subscriber: number, event: FilesChanged) => void;
  readonly enabled?: boolean;
};

/** A node on another machine that windows here have open, and which windows. */
type RemoteSession = { readonly machine: string; readonly ref: FilesNodeRef; readonly subscribers: Set<number> };

/** A session is the node on one machine: a node whose host is re-pointed opens a new one. */
const keyOf = (ref: FilesNodeRef, machine: string): string => `${ref.canvas}\u0000${ref.node}\u0000${machine}`;
const sameRef = (a: FilesNodeRef, b: FilesNodeRef): boolean => a.canvas === b.canvas && a.node === b.node;

export const makeFilesRouter = (deps: FilesRouterDeps) => {
  const enabled = deps.enabled ?? FILES_REMOTE_ENABLED;
  const sessions = new Map<string, RemoteSession>();
  let listening: FilesRemotePort | undefined;

  /** A machine's changes go to the windows that have that node open there. */
  const listen = (remote: FilesRemotePort): void => {
    if (listening === remote) return;
    listening = remote;
    remote.onChange(({ machine, change }) => {
      for (const [key, session] of sessions) {
        if (session.machine !== machine || session.ref.node !== change.node) continue;
        for (const subscriber of session.subscribers) deps.send(subscriber, change);
        // The host closed it for good; a lost link is said and opened again by the client.
        if (change.kind === "closed" && change.error !== "unreachable") sessions.delete(key);
      }
    });
  };

  /** The node's machine and the link to it, when it is not this machine; undefined for the local service. */
  const elsewhere = async (ref: FilesNodeRef): Promise<{ readonly remote: FilesRemotePort; readonly machine: string } | undefined> => {
    if (!enabled) return undefined;
    const remote = deps.remote();
    if (remote === undefined) return undefined;
    const facts = await deps.node(ref);
    if (facts === undefined || facts.host === (await deps.machineName())) return undefined;
    listen(remote);
    return { remote, machine: facts.host };
  };

  /**
   * A window leaves a node. The last one closes it on its machine; the session
   * is kept until that close answers, so a close the link refused is logged,
   * not forgotten. A window opening the node meanwhile starts a new session.
   */
  const leave = (key: string, subscriber: number): void => {
    const session = sessions.get(key);
    if (session === undefined || !session.subscribers.delete(subscriber) || session.subscribers.size > 0) return;
    const remote = deps.remote();
    if (remote === undefined) {
      sessions.delete(key);
      return;
    }
    void remote.close(session.machine, session.ref).then(
      (result) => {
        if (!result.ok) console.error("[files] closing a node on another machine was refused", { machine: session.machine, error: result.error });
      },
      (cause: unknown) => console.error("[files] closing a node on another machine failed", { machine: session.machine }, cause),
    ).finally(() => {
      if (sessions.get(key) === session) sessions.delete(key);
    });
  };

  /** The sessions a window holds for this node, on whichever machine. */
  const keysFor = (subscriber: number, ref: FilesNodeRef): ReadonlyArray<string> =>
    [...sessions].flatMap(([key, session]) => (sameRef(session.ref, ref) && session.subscribers.has(subscriber) ? [key] : []));

  /** Route a call that names only the node. */
  const routed = async <A>(
    ref: FilesNodeRef,
    there: (remote: FilesRemotePort, machine: string) => Promise<FilesResult<A>>,
    here: () => Promise<FilesResult<A>> | FilesResult<A>,
  ): Promise<FilesResult<A>> => {
    const away = await elsewhere(ref);
    return away === undefined ? here() : there(away.remote, away.machine);
  };

  return {
    open: async (subscriber: number, ref: FilesNodeRef): Promise<FilesResult<FilesRoot>> => {
      const away = await elsewhere(ref);
      if (away === undefined) return deps.local.open(subscriber, ref);
      const result = await away.remote.open(away.machine, ref);
      if (result.ok) {
        const key = keyOf(ref, away.machine);
        const held = sessions.get(key);
        // One whose last window left and is closing there is not joined: this open starts afresh.
        const session = held !== undefined && held.subscribers.size > 0 ? held : { machine: away.machine, ref, subscribers: new Set<number>() };
        session.subscribers.add(subscriber);
        sessions.set(key, session);
      }
      return result;
    },
    close: async (subscriber: number, ref: FilesNodeRef): Promise<FilesResult<null>> => {
      const keys = keysFor(subscriber, ref);
      if (keys.length === 0) return deps.local.close(subscriber, ref);
      for (const key of keys) leave(key, subscriber);
      return { ok: true, value: null };
    },
    /** A window went away: its local sessions, and the remote nodes only it had open. */
    closeSubscriber: (subscriber: number): void => {
      deps.local.closeSubscriber(subscriber);
      for (const key of [...sessions.keys()]) leave(key, subscriber);
    },
    count: (ref: FilesNodeRef): Promise<FilesResult<FilesCount>> =>
      routed(ref, (remote, machine) => remote.count(machine, ref), () => deps.local.count(ref)),
    list: (ref: FilesNodeRef, dir: FilePath): Promise<FilesResult<ReadonlyArray<FileEntry>>> =>
      routed(ref, (remote, machine) => remote.list(machine, ref, dir), () => deps.local.list(ref, dir)),
    search: (subscriber: number, ref: FilesNodeRef, query: string, seq: number): Promise<FilesResult<FilesSearchResult>> =>
      routed(ref, (remote, machine) => remote.search(machine, ref, query, seq), () => deps.local.search(subscriber, ref, query, seq)),
    read: (ref: FilesNodeRef, path: FilePath): Promise<FilesResult<FileRead>> =>
      routed(ref, (remote, machine) => remote.read(machine, ref, path), () => deps.local.read(ref, path)),
    write: (ref: FilesNodeRef, path: FilePath, text: string, base: FileStamp | null): Promise<FilesResult<FileStamp>> =>
      routed(ref, (remote, machine) => remote.write(machine, ref, path, text, base), () => deps.local.write(ref, path, text, base)),
    create: (ref: FilesNodeRef, path: FilePath, dir: boolean): Promise<FilesResult<FileEntry>> =>
      routed(ref, (remote, machine) => remote.create(machine, ref, path, dir), () => deps.local.create(ref, path, dir)),
    rename: (ref: FilesNodeRef, path: FilePath, name: string): Promise<FilesResult<FilePath>> =>
      routed(ref, (remote, machine) => remote.rename(machine, ref, path, name), () => deps.local.rename(ref, path, name)),
    move: (ref: FilesNodeRef, path: FilePath, intoDir: FilePath): Promise<FilesResult<FilePath>> =>
      routed(ref, (remote, machine) => remote.move(machine, ref, path, intoDir), () => deps.local.move(ref, path, intoDir)),
    trash: (ref: FilesNodeRef, path: FilePath): Promise<FilesResult<null>> =>
      routed(ref, (remote, machine) => remote.trash(machine, ref, path), () => deps.local.trash(ref, path)),
  };
};

export type FilesRouter = ReturnType<typeof makeFilesRouter>;
