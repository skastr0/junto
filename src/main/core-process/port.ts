import { CoreCallError, runCoreOp, type CoreClient, type CoreFailure, type CoreRunner } from "./client";

/**
 * The one ordered port between Electron main and the core process (Wave 3).
 * Main sends calls; the core answers each by id and pushes changes on named
 * channels. Calls and pushes share the port, so a push sent after a commit
 * reaches main after the answer of the call that made it, in commit order.
 *
 * `CorePort` is the least both ends offer: Electron's `UtilityProcess` and the
 * child's `process.parentPort`, or a `MessagePort` in tests.
 */
export type CorePort = {
  readonly post: (message: CoreMessage) => void;
  readonly listen: (handler: (message: CoreMessage) => void) => () => void;
};

export type CoreMessage =
  | { readonly kind: "call"; readonly id: number; readonly name: string; readonly input: unknown }
  | { readonly kind: "answer"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly kind: "answer"; readonly id: number; readonly ok: false; readonly failure: CoreFailure }
  | { readonly kind: "push"; readonly channel: string; readonly payload: unknown };

/** Main's side: calls go out, answers and pushes come back. */
export type PortCoreClient = CoreClient & {
  readonly onPush: (channel: string, listener: (payload: unknown) => void) => () => void;
  /** Rejects every call in flight; the port is gone (the core process stopped). */
  readonly fail: (reason: string) => void;
};

export const portCore = (port: CorePort): PortCoreClient => {
  let nextId = 1;
  const pending = new Map<number, { readonly name: string; readonly resolve: (value: never) => void; readonly reject: (error: Error) => void }>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  port.listen((message) => {
    if (message.kind === "push") {
      for (const listener of listeners.get(message.channel) ?? []) listener(message.payload);
      return;
    }
    if (message.kind !== "answer") return;
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value as never);
    else entry.reject(new CoreCallError(entry.name, message.failure.tag, message.failure.message));
  });
  return {
    call: (name, input) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { name, resolve, reject });
        port.post({ kind: "call", id, name, input });
      }),
    onPush: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      listeners.set(channel, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    fail: (reason) => {
      for (const [id, entry] of pending) {
        pending.delete(id);
        entry.reject(new CoreCallError(entry.name, "CoreStopped", reason));
      }
    },
  };
};

/** The core's side: answer every call by running its operation; push changes. */
export const serveCore = (port: CorePort, runner: CoreRunner): { readonly push: (channel: string, payload: unknown) => void; readonly close: () => void } => {
  const close = port.listen((message) => {
    if (message.kind !== "call") return;
    void runCoreOp(runner, message.name, message.input).then(
      (answer) => port.post(answer.ok
        ? { kind: "answer", id: message.id, ok: true, value: answer.value }
        : { kind: "answer", id: message.id, ok: false, failure: answer.failure }),
      (error: unknown) => port.post({
        kind: "answer", id: message.id, ok: false,
        failure: { tag: "CoreDefect", message: error instanceof Error ? error.message : String(error) },
      }),
    );
  });
  return { push: (channel, payload) => port.post({ kind: "push", channel, payload }), close };
};
