import { Effect, Schema } from "effect";
import type { RpcPortMessage } from "../../shared/rpc-port";

/**
 * The one ordered port between Electron main and the core process (Wave 3).
 * The core pushes changes on named channels, in the order they were
 * published, which is commit order; a push published while a request runs
 * arrives before that request's answer.
 *
 * Everything else rides Effect RPC on the same port (`src/shared/rpc-port.ts`):
 * main's calls to the core are the typed groups of `src/contract/core/`, and
 * the core's calls to main are the host groups of `src/contract/host/`.
 *
 * `CorePort` is the least both ends offer: Electron's `UtilityProcess` and the
 * child's `process.parentPort`, or a `MessagePort` in tests.
 */
export type CorePort = {
  readonly post: (message: CoreMessage) => void;
  readonly listen: (handler: (message: CoreMessage) => void) => () => void;
};

export type CoreMessage = RpcPortMessage | { readonly kind: "push"; readonly channel: string; readonly payload: unknown };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A message the port refused: its value could not be cloned, or the port is gone. */
class PortPostFailed extends Schema.TaggedError<PortPostFailed>()("PortPostFailed", { message: Schema.String }) {}

export const post = (port: CorePort, message: CoreMessage): Effect.Effect<void, PortPostFailed> =>
  Effect.try({ try: () => port.post(message), catch: (cause) => new PortPostFailed({ message: messageOf(cause) }) });

/** Main's side: the core's pushes, by channel. */
export type PortPushes = {
  readonly onPush: (channel: string, listener: (payload: unknown) => void) => () => void;
};

export const portPushes = (port: CorePort): PortPushes => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  port.listen((message) => {
    if (message.kind !== "push") return;
    for (const listener of listeners.get(message.channel) ?? []) listener(message.payload);
  });
  return {
    onPush: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      listeners.set(channel, set);
      set.add(listener);
      return () => set.delete(listener);
    },
  };
};
