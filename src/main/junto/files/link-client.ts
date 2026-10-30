import { Effect } from "effect";
import type {
  FileEntry, FileImported, FilePath, FileRead, FilesChanged, FilesCount, FilesNodeRef, FilesResult, FilesRoot,
  FilesSearchResult, FileStamp,
} from "@shared/files";
import { decodeFilesResponse, fitsOneFrame, type FilesEvent, type FilesRequest, type FilesResponse } from "@shared/files-link";
import type { NodeId } from "@shared/physics/schema";
import { MachineLink } from "../link/service";
import type { LinkEventContext } from "../link/types";
import { MachineRepository } from "../machines/repository";

/**
 * The window machine's end of the `files` channel (0.12, X1d): one function
 * per op, over the link to the machine that holds the node.
 *
 * `unreachable` is made here, from the link, and nowhere else: it means no
 * link to that machine is open, or the link was lost during the call. The
 * host's own refusals (`denied` for a peer that is not the editor, `elsewhere`
 * for a node on another host) are answers and cross as they are, so a card
 * never says a machine is offline when it is not.
 *
 * Nothing is cached: a listing, a name or a text is returned and forgotten. A
 * save in flight when the link drops is refused `unreachable`, never queued.
 */

export type RemoteChange = { readonly machine: string; readonly change: FilesChanged };

/** Link failures that mean no usable link; the rest are this call failing. */
const NO_LINK_TAGS: ReadonlySet<string> = new Set(["LinkClosed", "LinkPeerNotPinned", "LinkBuildMismatch", "LinkHelloRefused"]);
const NO_LINK_REASONS: ReadonlySet<string> = new Set([
  "not-linked", "not-configured", "shutting-down", "route-incomplete", "other-installation", "not-admitted", "channel-unavailable",
  "listener-unavailable", "asleep",
]);
const noLink = (failure: { readonly _tag?: string; readonly reason?: string }): boolean =>
  failure._tag !== undefined && (NO_LINK_TAGS.has(failure._tag) || (failure._tag === "LinkUnavailable" && NO_LINK_REASONS.has(failure.reason ?? "")));

export type FilesRemoteOptions = { readonly now?: () => number };

export const makeFilesRemote = Effect.fn("FilesRemote.make")(function* (options: FilesRemoteOptions = {}) {
  const link = yield* MachineLink;
  const machines = yield* MachineRepository;
  const now = options.now ?? Date.now;
  /** When each machine last answered, or sent a change, or its link went down. In memory only. */
  const reached = new Map<string, number>();
  /** The nodes a window has open on each machine, to open again when its link comes back. */
  const watching = new Map<string, Map<NodeId, string>>();
  const listeners = new Set<(change: RemoteChange) => void>();

  const emit = (machine: string, change: FilesChanged): void => {
    for (const listener of listeners) listener({ machine, change });
  };
  const unreachable = (machine: string) => ({ ok: false, error: "unreachable", machine, lastReachedAt: reached.get(machine) ?? null }) as const;
  const failed = { ok: false, error: "failed" } as const;

  /** The answer, or the refusal this call ends in. */
  const send = async (machine: string, request: FilesRequest): Promise<FilesResponse | ReturnType<typeof unreachable> | typeof failed> => {
    const result = await Effect.runPromise(Effect.result(link.request(machine, "files", request)));
    if (result._tag === "Failure") return noLink(result.failure) ? unreachable(machine) : failed;
    try {
      const response = decodeFilesResponse(result.success);
      reached.set(machine, now());
      return response;
    } catch {
      return failed;
    }
  };

  const ok = <A>(value: A): FilesResult<A> => ({ ok: true, value });
  const answer = async <A, T extends FilesResponse["_tag"]>(
    machine: string,
    request: FilesRequest,
    tag: T,
    pick: (response: Extract<FilesResponse, { _tag: T }>) => A,
  ): Promise<FilesResult<A>> => {
    const response = await send(machine, request);
    if (!("_tag" in response)) return response;
    if (response._tag === "Refused") return { ok: false, error: response.error };
    return response._tag === tag ? ok(pick(response as Extract<FilesResponse, { _tag: T }>)) : failed;
  };
  const where = (ref: FilesNodeRef) => ({ canvas: ref.canvas, node: ref.node }) as const;

  const open = async (machine: string, ref: FilesNodeRef): Promise<FilesResult<FilesRoot>> => {
    const result = await answer(machine, { _tag: "Open", ...where(ref) }, "Opened", (response) => response.root);
    // A node opened while the machine is unreachable is watched too: when the link returns it opens again and says back.
    if (result.ok || result.error === "unreachable") {
      const nodes = watching.get(machine) ?? new Map<NodeId, string>();
      nodes.set(ref.node, ref.canvas);
      watching.set(machine, nodes);
    }
    return result;
  };

  const forget = (machine: string, node: NodeId): void => {
    const nodes = watching.get(machine);
    nodes?.delete(node);
    if (nodes?.size === 0) watching.delete(machine);
  };

  const close = async (machine: string, ref: FilesNodeRef): Promise<FilesResult<null>> => {
    forget(machine, ref.node);
    return answer(machine, { _tag: "Close", ...where(ref) }, "Closed", () => null);
  };

  /** The link came back: open every watched node again and say `back`, or why it will not. */
  const reopen = async (machine: string): Promise<void> => {
    for (const [node, canvas] of [...(watching.get(machine) ?? [])]) {
      const result = await answer(machine, { _tag: "Open", canvas, node }, "Opened", (response) => response.root);
      if (result.ok) {
        emit(machine, { node: node, kind: "back" });
        continue;
      }
      if (result.error === "unreachable") return;
      forget(machine, node);
      emit(machine, { node: node, kind: "closed", error: result.error } as FilesChanged);
    }
  };

  /** A change a host sent for a node a window here has open on that machine; anything else is dropped. */
  const onEvent = (context: LinkEventContext, event: FilesEvent): Effect.Effect<void, unknown> => Effect.gen(function* () {
    const machine = context.peer.machineName;
    const peer = yield* machines.peer(machine);
    if (peer?.installationId !== context.peer.installationId) return;
    if (watching.get(machine)?.has(event.node) !== true) return;
    reached.set(machine, now());
    if (event.kind === "closed") forget(machine, event.node);
    emit(machine, event as FilesChanged);
  });

  const onOpened = (context: LinkEventContext): Effect.Effect<void> => Effect.sync(() => {
    const machine = context.peer.machineName;
    reached.set(machine, now());
    // The hook may not wait on its own link: the reopen runs after it returns.
    void reopen(machine);
  });

  const onClosed = (context: LinkEventContext): Effect.Effect<void> => Effect.sync(() => {
    const machine = context.peer.machineName;
    reached.set(machine, now());
    for (const node of watching.get(machine)?.keys() ?? []) {
      emit(machine, { node: node, kind: "closed", error: "unreachable", machine, lastReachedAt: reached.get(machine) ?? null });
    }
  });

  return {
    onEvent, onOpened, onClosed,
    /** Changes under nodes opened here: a host's, and `closed` with `unreachable` then `back` as a link drops and returns. */
    onChange: (listener: (change: RemoteChange) => void): (() => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    open, close,
    count: (machine: string, ref: FilesNodeRef): Promise<FilesResult<FilesCount>> =>
      answer(machine, { _tag: "Count", ...where(ref) }, "Counted", ({ files, capped }) => ({ files, capped })),
    list: (machine: string, ref: FilesNodeRef, dir: FilePath): Promise<FilesResult<ReadonlyArray<FileEntry>>> =>
      answer(machine, { _tag: "List", ...where(ref), dir }, "Listed", (response) => response.entries),
    read: (machine: string, ref: FilesNodeRef, path: FilePath): Promise<FilesResult<FileRead>> =>
      answer(machine, { _tag: "Read", ...where(ref), path }, "Read", (response) => response.read),
    write: async (machine: string, ref: FilesNodeRef, path: FilePath, text: string, base: FileStamp | null): Promise<FilesResult<FileStamp>> =>
      // A text over one frame is refused here, before the link: X3 sends it in chunks.
      fitsOneFrame(text)
        ? answer(machine, { _tag: "Write", ...where(ref), path, text, base }, "Written", (response) => response.stamp)
        : { ok: false, error: "too-large" },
    create: (machine: string, ref: FilesNodeRef, path: FilePath, dir: boolean): Promise<FilesResult<FileEntry>> =>
      answer(machine, { _tag: "Create", ...where(ref), path, dir }, "Created", (response) => response.entry),
    rename: (machine: string, ref: FilesNodeRef, path: FilePath, name: string): Promise<FilesResult<FilePath>> =>
      answer(machine, { _tag: "Rename", ...where(ref), path, name }, "Renamed", (response) => response.path),
    move: (machine: string, ref: FilesNodeRef, path: FilePath, into: FilePath): Promise<FilesResult<FilePath>> =>
      answer(machine, { _tag: "Move", ...where(ref), path, into }, "Moved", (response) => response.path),
    trash: (machine: string, ref: FilesNodeRef, path: FilePath): Promise<FilesResult<null>> =>
      answer(machine, { _tag: "Trash", ...where(ref), path }, "Trashed", () => null),
    import: (machine: string, ref: FilesNodeRef, into: FilePath): Promise<FilesResult<ReadonlyArray<FileImported>>> =>
      answer(machine, { _tag: "Import", ...where(ref), into }, "Imported", (response) => response.imported),
    search: (machine: string, ref: FilesNodeRef, query: string, seq: number): Promise<FilesResult<FilesSearchResult>> =>
      answer(machine, { _tag: "Search", ...where(ref), query, seq }, "Searched", (response) => response.search),
    /** The nodes opened here on a machine; for tests and the router. */
    watched: (machine: string): ReadonlyArray<string> => [...(watching.get(machine)?.keys() ?? [])],
  };
});

export type FilesRemote = Effect.Success<ReturnType<typeof makeFilesRemote>>;
