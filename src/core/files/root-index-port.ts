import type { FilesCount } from "@shared/files";
import type { IndexSearch } from "./index-engine";
import { makeRootIndex, type RootEvent, type RootIndex } from "./root-index";
import { makeNameSources, type GitRun } from "./sources";
import type { Timers, WatchFactory } from "./watcher";

/**
 * The root index across a thread: main calls hold, release, search and
 * count; the worker answers, sends root events, and asks main to run git
 * (main owns every child on the process plane), getting git's stdout back
 * as bytes it decodes itself.
 */

/** One end of a channel: a worker, its parentPort, or a MessagePort. */
export type Port = {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
};

type Op = "hold" | "release" | "search" | "count";

type ToWorker =
  | { readonly kind: "call"; readonly id: number; readonly op: Op; readonly args: ReadonlyArray<string> }
  | { readonly kind: "gitBytes"; readonly id: number; readonly chunk: Uint8Array }
  | { readonly kind: "gitExit"; readonly id: number; readonly code: number | null }
  | { readonly kind: "gitFailed"; readonly id: number; readonly error: string };

type ToMain =
  | { readonly kind: "reply"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly kind: "reply"; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly kind: "event"; readonly root: string; readonly event: RootEvent }
  | {
      readonly kind: "git";
      readonly id: number;
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin?: string;
    }
  | { readonly kind: "gitAbort"; readonly id: number };

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** The worker side: a root index whose git runs in main. */
export const serveRootIndex = (
  port: Port,
  options: { readonly watch?: WatchFactory; readonly timers?: Timers } = {},
): void => {
  let nextGit = 0;
  const runs = new Map<
    number,
    { readonly onBytes: (chunk: Uint8Array) => void; readonly done: (code: number | null) => void; readonly fail: (cause: Error) => void }
  >();
  const run: GitRun = (cwd, args, onBytes, signal, stdin) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      nextGit += 1;
      const id = nextGit;
      const abort = (): void => port.postMessage({ kind: "gitAbort", id } satisfies ToMain);
      const finish = (): void => {
        runs.delete(id);
        signal.removeEventListener("abort", abort);
      };
      runs.set(id, {
        onBytes,
        done: (code) => {
          finish();
          resolve(code);
        },
        fail: (cause) => {
          finish();
          reject(cause);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      port.postMessage({ kind: "git", id, cwd, args, ...(stdin === undefined ? {} : { stdin }) } satisfies ToMain);
    });
  const index = makeRootIndex({
    names: makeNameSources(run),
    emit: (root, event) => port.postMessage({ kind: "event", root, event } satisfies ToMain),
    ...options,
  });
  const answer = (op: Op, [root = "", second = "", third = ""]: ReadonlyArray<string>): Promise<unknown> =>
    op === "hold"
      ? index.hold(root, second)
      : op === "release"
        ? index.release(root, second)
        : op === "search"
          ? index.search(root, second, third)
          : index.count(root);
  port.on("message", (raw) => {
    const message = raw as ToWorker;
    if (message.kind === "call") {
      answer(message.op, message.args).then(
        (value) => port.postMessage({ kind: "reply", id: message.id, ok: true, value } satisfies ToMain),
        (cause: unknown) => port.postMessage({ kind: "reply", id: message.id, ok: false, error: messageOf(cause) } satisfies ToMain),
      );
      return;
    }
    const waiting = runs.get(message.id);
    if (waiting === undefined) return;
    if (message.kind === "gitBytes") waiting.onBytes(message.chunk);
    else if (message.kind === "gitExit") waiting.done(message.code);
    else waiting.fail(new Error(message.error));
  });
};

/**
 * The main side: calls out, replies matched by id, root events to `emit`,
 * and git run here for the worker. `lost` rejects every pending call and
 * ends every git the worker asked for; `onIdle` fires when nothing is pending.
 */
export const portRootIndex = (
  port: Port,
  deps: { readonly git: GitRun; readonly emit: (root: string, event: RootEvent) => void; readonly onIdle?: () => void },
): RootIndex & { readonly lost: (cause: Error) => void; readonly idle: () => boolean } => {
  let next = 0;
  const pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (cause: Error) => void }>();
  const gits = new Map<number, AbortController>();
  const idle = (): boolean => pending.size === 0 && gits.size === 0;
  const settled = (): void => {
    if (idle()) deps.onIdle?.();
  };
  const runGit = (message: Extract<ToMain, { kind: "git" }>): void => {
    const abort = new AbortController();
    gits.set(message.id, abort);
    deps
      .git(message.cwd, message.args, (chunk) => {
        // A copy of just these bytes, moved across rather than cloned again.
        const own = new Uint8Array(chunk);
        port.postMessage({ kind: "gitBytes", id: message.id, chunk: own } satisfies ToWorker, [own.buffer]);
      }, abort.signal, message.stdin)
      .then(
        (code) => port.postMessage({ kind: "gitExit", id: message.id, code } satisfies ToWorker),
        (cause: unknown) => port.postMessage({ kind: "gitFailed", id: message.id, error: messageOf(cause) } satisfies ToWorker),
      )
      .finally(() => {
        gits.delete(message.id);
        settled();
      });
  };
  port.on("message", (raw) => {
    const message = raw as ToMain;
    if (message.kind === "event") deps.emit(message.root, message.event);
    else if (message.kind === "git") runGit(message);
    else if (message.kind === "gitAbort") gits.get(message.id)?.abort();
    else {
      const waiting = pending.get(message.id);
      if (waiting === undefined) return;
      pending.delete(message.id);
      if (message.ok) waiting.resolve(message.value);
      else waiting.reject(new Error(message.error));
      settled();
    }
  });
  const call = <A>(op: Op, args: ReadonlyArray<string>): Promise<A> =>
    new Promise<A>((resolve, reject) => {
      next += 1;
      pending.set(next, { resolve: resolve as (value: unknown) => void, reject });
      port.postMessage({ kind: "call", id: next, op, args } satisfies ToWorker);
    });
  return {
    hold: (root, session) => call<{ readonly repo: boolean }>("hold", [root, session]),
    release: (root, session) => call<FilesCount | undefined>("release", [root, session]),
    search: (root, session, query) => call<IndexSearch>("search", [root, session, query]),
    count: (root) => call<FilesCount>("count", [root]),
    lost: (cause) => {
      for (const waiting of pending.values()) waiting.reject(cause);
      pending.clear();
      for (const abort of gits.values()) abort.abort();
    },
    idle,
  };
};
