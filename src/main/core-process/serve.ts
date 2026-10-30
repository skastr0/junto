import { Effect, Exit } from "effect";
import { coreFailureOf, type CoreFailure } from "./client";
import { HostCallError, type HostClient } from "./host-ops";
import { coreOpBody } from "./ops";
import { messageOf, post, postAnswer, type CoreMessage, type CorePort } from "./port";

/**
 * The core's side of the port: the one place a named operation runs. Entry
 * imports this file; main never does, so main links no operation body.
 */

/** Something that runs a core effect: the core's own runtime. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CoreRunner = { readonly runPromiseExit: (effect: Effect.Effect<any, any, any>) => Promise<Exit.Exit<any, any>> };

/** Run one named operation on a runner; the answer or a `CoreFailure`. */
export const runCoreOp = async (
  runner: CoreRunner,
  name: string,
  input: unknown,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: CoreFailure }> => {
  const body = coreOpBody(name);
  if (body === undefined) return { ok: false, failure: { tag: "UnknownCoreOp", message: `no core operation named ${name}` } };
  const exit = await runner.runPromiseExit(Effect.suspend(() => body(input as never)));
  return Exit.isSuccess(exit) ? { ok: true, value: exit.value } : { ok: false, failure: coreFailureOf(exit.cause) };
};

/**
 * The core's side: answer every call by running its operation; push changes; ask main through `host`.
 * `runner` may still be starting: the host side and pushes work at once, and a call waits for it.
 */
export const serveCore = (port: CorePort, runner: CoreRunner | Promise<CoreRunner>): {
  readonly push: (channel: string, payload: unknown) => void;
  readonly host: HostClient;
  /** Rejects every host call in flight; main is gone. */
  readonly failHost: (reason: string) => void;
  readonly close: () => void;
} => {
  let nextHostId = 1;
  const asked = new Map<number, { readonly name: string; readonly resolve: (value: never) => void; readonly reject: (error: Error) => void }>();
  const close = port.listen((message) => {
    if (message.kind === "hostAnswer") {
      const entry = asked.get(message.id);
      if (entry === undefined) return;
      asked.delete(message.id);
      if (message.ok) entry.resolve(message.value as never);
      else entry.reject(new HostCallError(entry.name, message.failure.tag, message.failure.message));
      return;
    }
    if (message.kind !== "call") return;
    void Promise.resolve(runner).then((ready) => runCoreOp(ready, message.name, message.input)).then(
      (answer) => postAnswer(port, answer.ok
        ? { kind: "answer", id: message.id, ok: true, value: answer.value }
        : { kind: "answer", id: message.id, ok: false, failure: answer.failure }),
      (error: unknown) => postAnswer(port, {
        kind: "answer", id: message.id, ok: false,
        failure: { tag: "CoreDefect", message: messageOf(error) },
      }),
    );
  });
  const host: HostClient = {
    call: (name, input) =>
      new Promise((resolve, reject) => {
        const id = nextHostId++;
        asked.set(id, { name, resolve, reject });
        post(port, { kind: "hostCall", id, name, input }).pipe(
          Effect.catchTag("PortPostFailed", ({ message }) =>
            Effect.sync(() => {
              asked.delete(id);
              reject(new HostCallError(name, "HostInputNotCloneable", message));
            })),
          Effect.runSync,
        );
      }),
  };
  const failHost = (reason: string): void => {
    for (const [id, entry] of asked) {
      asked.delete(id);
      entry.reject(new HostCallError(entry.name, "HostStopped", reason));
    }
  };
  // A push that cannot cross the port is dropped and logged, never thrown into the operation that pushed.
  const push = (channel: string, payload: unknown): void =>
    post(port, { kind: "push", channel, payload }).pipe(
      Effect.catchTag("PortPostFailed", ({ message }) => Effect.logWarning(`core port: a push on ${channel} could not be posted: ${message}`)),
      Effect.runSync,
    );
  return { push, host, failHost, close };
};
