import { Effect, Schema } from "effect";
import { CoreCallError, type CoreClient, type CoreFailure } from "./client";
import { runHostOp, type HostFailure } from "./host-ops";

/**
 * The one ordered port between Electron main and the core process (Wave 3).
 * Main sends calls; the core answers each by id and pushes changes on named
 * channels. Calls run at once, as they do in process, so answers come back
 * in the order their operations finish, not the order they were asked.
 * Pushes keep the order they were published in, which is commit order; a
 * push published while an operation runs arrives before that operation's
 * answer.
 *
 * The core asks main the same way, the other way round (`HostOps`): a
 * `hostCall` out of the core, a `hostAnswer` back, by id, in the order main's
 * bodies finish.
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
  | { readonly kind: "push"; readonly channel: string; readonly payload: unknown }
  | { readonly kind: "hostCall"; readonly id: number; readonly name: string; readonly input: unknown }
  | { readonly kind: "hostAnswer"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly kind: "hostAnswer"; readonly id: number; readonly ok: false; readonly failure: HostFailure };

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A message the port refused: its value could not be cloned, or the port is gone. */
class PortPostFailed extends Schema.TaggedError<PortPostFailed>()("PortPostFailed", { message: Schema.String }) {}

export const post = (port: CorePort, message: CoreMessage): Effect.Effect<void, PortPostFailed> =>
  Effect.try({ try: () => port.post(message), catch: (cause) => new PortPostFailed({ message: messageOf(cause) }) });

export type AnswerMessage = Extract<CoreMessage, { readonly kind: "answer" | "hostAnswer" }>;

/**
 * Post an answer, or, when its value cannot be cloned across the port, a
 * failure in its place, so the caller hears back instead of waiting forever.
 * Run at the port's edge, where the message handler is plain JavaScript.
 */
export const postAnswer = (port: CorePort, answer: AnswerMessage): void =>
  post(port, answer).pipe(
    Effect.catchTag("PortPostFailed", ({ message }) => {
      const failure = { tag: "CoreAnswerNotCloneable", message };
      return post(port, answer.kind === "answer"
        ? { kind: "answer", id: answer.id, ok: false, failure }
        : { kind: "hostAnswer", id: answer.id, ok: false, failure });
    }),
    Effect.catchTag("PortPostFailed", ({ message }) => Effect.logWarning(`core port: an answer could not be posted: ${message}`)),
    Effect.runSync,
  );

/** Main's side: calls go out, answers and pushes come back; the core's host calls are answered here. */
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
    if (message.kind === "hostCall") {
      void runHostOp(message.name, message.input).then((answer) => postAnswer(port, answer.ok
        ? { kind: "hostAnswer", id: message.id, ok: true, value: answer.value }
        : { kind: "hostAnswer", id: message.id, ok: false, failure: answer.failure }));
      return;
    }
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
        post(port, { kind: "call", id, name, input }).pipe(
          Effect.catchTag("PortPostFailed", ({ message }) =>
            Effect.sync(() => {
              pending.delete(id);
              reject(new CoreCallError(name, "CoreInputNotCloneable", message));
            })),
          Effect.runSync,
        );
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
