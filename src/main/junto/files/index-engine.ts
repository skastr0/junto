import type { FileMatch } from "@shared/files";
import { NameIndex, NameIndexBuilder, type MatchSet } from "./name-index";

/**
 * Where a root's name index lives and is searched. The service in main
 * finds the names (git, a walk, the watcher) and hands them over; the engine
 * builds, holds and searches the index. In the app the engine is a worker
 * thread (`index-worker.ts`), so a 30 ms search or a 200k build never blocks
 * main's loop, which carries every window's IPC and terminal output; tests
 * run the same handler in process.
 *
 * An index sits in a numbered slot. A rebuild fills a new slot while the old
 * one keeps answering, then the service drops the old one.
 */

/** A batch of changes for one index, already classified by main (lstat, ignore rules, links). */
export type IndexDelta = {
  /** Files that exist now. */
  readonly adds: ReadonlyArray<string>;
  /** Paths that went away: a file in the index, else a folder to sweep. */
  readonly gone: ReadonlyArray<string>;
  /** Paths that exist but must not be listed (a link that points out of the root). */
  readonly drop: ReadonlyArray<string>;
};

export type IndexState = { readonly size: number; readonly drift: number };

/** `overflow`: more folders went than a sweep is worth; the service rebuilds instead. */
export type DeltaOutcome = IndexState & { readonly overflow: boolean };

export type IndexSearch = { readonly matches: ReadonlyArray<FileMatch>; readonly total: number };

export interface IndexEngine {
  begin(slot: number): void;
  names(slot: number, names: ReadonlyArray<string>): void;
  finish(slot: number): Promise<IndexState>;
  apply(slot: number, delta: IndexDelta): Promise<DeltaOutcome>;
  /** Narrows from the session's previous query on the same slot when it can. */
  search(slot: number, session: string, query: string): Promise<IndexSearch>;
  forget(slot: number, session: string): void;
  drop(slot: number): void;
}

/** Folders gone in one batch past which a rebuild is cheaper than a sweep. */
export const SWEEP_MAX = 64;

type Slot = { builder?: NameIndexBuilder; index?: NameIndex; readonly sets: Map<string, MatchSet> };

/** The engine's work, wherever it runs. */
export const makeIndexHandler = () => {
  const slots = new Map<number, Slot>();
  const indexIn = (slot: number): { readonly index: NameIndex; readonly sets: Map<string, MatchSet> } => {
    const held = slots.get(slot);
    if (held?.index === undefined) throw new Error(`no index in slot ${String(slot)}`);
    return { index: held.index, sets: held.sets };
  };
  return {
    begin: (slot: number): void => {
      slots.set(slot, { builder: new NameIndexBuilder(), sets: new Map() });
    },
    names: (slot: number, names: ReadonlyArray<string>): void => {
      slots.get(slot)?.builder?.add(names);
    },
    finish: async (slot: number): Promise<IndexState> => {
      const held = slots.get(slot);
      if (held?.builder === undefined) throw new Error(`no build in slot ${String(slot)}`);
      const index = await held.builder.finish();
      held.builder = undefined;
      held.index = index;
      return { size: index.size, drift: index.drift };
    },
    apply: async (slot: number, delta: IndexDelta): Promise<DeltaOutcome> => {
      const { index } = indexIn(slot);
      for (const path of delta.drop) if (index.has(path)) index.remove(path);
      const folders: string[] = [];
      for (const path of delta.gone) {
        if (index.has(path)) index.remove(path);
        else folders.push(path);
      }
      if (folders.length > SWEEP_MAX) return { size: index.size, drift: index.drift, overflow: true };
      index.removeUnder(folders);
      for (const path of delta.adds) index.add(path);
      return { size: index.size, drift: index.drift, overflow: false };
    },
    search: async (slot: number, session: string, query: string): Promise<IndexSearch> => {
      const { index, sets } = indexIn(slot);
      if (query.trim() === "") return { matches: [], total: index.size };
      const { matches, set } = index.search(query, sets.get(session));
      sets.set(session, set);
      return { matches, total: index.size };
    },
    forget: (slot: number, session: string): void => {
      slots.get(slot)?.sets.delete(session);
    },
    drop: (slot: number): void => {
      slots.delete(slot);
    },
  };
};

type Handler = ReturnType<typeof makeIndexHandler>;

/** The handler in this thread: tests, and anywhere a worker cannot start. */
export const inProcessEngine = (): IndexEngine => makeIndexHandler();

/** One end of a channel: a worker, its parentPort, or a MessagePort. */
export type IndexPort = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
};

type Call =
  | { readonly op: "finish"; readonly slot: number }
  | { readonly op: "apply"; readonly slot: number; readonly delta: IndexDelta }
  | { readonly op: "search"; readonly slot: number; readonly session: string; readonly query: string };

type Request =
  | { readonly op: "begin" | "drop"; readonly slot: number }
  | { readonly op: "names"; readonly slot: number; readonly names: string }
  | { readonly op: "forget"; readonly slot: number; readonly session: string }
  | (Call & { readonly id: number });

type Reply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** The worker side: run each request through the handler, in arrival order. */
export const serveIndex = (port: IndexPort, handler: Handler = makeIndexHandler()): void => {
  let queue = Promise.resolve();
  port.on("message", (raw) => {
    const request = raw as Request;
    queue = queue.then(async () => {
      if (!("id" in request)) {
        if (request.op === "names") {
          // Names cross as one string, NUL-joined: a single copy, not one per name.
          handler.names(request.slot, request.names.split("\0"));
        } else if (request.op === "forget") handler.forget(request.slot, request.session);
        else if (request.op === "begin") handler.begin(request.slot);
        else handler.drop(request.slot);
        return;
      }
      let reply: Reply;
      try {
        const value =
          request.op === "finish"
            ? await handler.finish(request.slot)
            : request.op === "apply"
              ? await handler.apply(request.slot, request.delta)
              : await handler.search(request.slot, request.session, request.query);
        reply = { id: request.id, ok: true, value };
      } catch (cause) {
        reply = { id: request.id, ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
      port.postMessage(reply);
    });
  });
};

/** The main side of a port: requests out, replies matched by id. `lost` rejects every pending call. */
export const portEngine = (port: IndexPort): IndexEngine & { readonly lost: (cause: Error) => void } => {
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>();
  port.on("message", (raw) => {
    const reply = raw as Reply;
    const waiting = pending.get(reply.id);
    if (waiting === undefined) return;
    pending.delete(reply.id);
    if (reply.ok) waiting.resolve(reply.value);
    else waiting.reject(new Error(reply.error));
  });
  const call = <A>(request: Call): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      next += 1;
      pending.set(next, { resolve: resolve as (value: unknown) => void, reject });
      port.postMessage({ ...request, id: next });
    });
  return {
    begin: (slot) => port.postMessage({ op: "begin", slot }),
    names: (slot, names) => port.postMessage({ op: "names", slot, names: names.join("\0") }),
    finish: (slot) => call<IndexState>({ op: "finish", slot }),
    apply: (slot, delta) => call<DeltaOutcome>({ op: "apply", slot, delta }),
    search: (slot, session, query) => call<IndexSearch>({ op: "search", slot, session, query }),
    forget: (slot, session) => port.postMessage({ op: "forget", slot, session }),
    drop: (slot) => port.postMessage({ op: "drop", slot }),
    lost: (cause) => {
      for (const waiting of pending.values()) waiting.reject(cause);
      pending.clear();
    },
  };
};
