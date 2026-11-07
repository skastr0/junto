/**
 * Main's end of the push channels: what the core announced, heard in main.
 * The port relay (`window-pushes.ts`) delivers each push the core sent, and
 * main-boot its own `coreRestarted`; the handlers that send to a window
 * subscribe to `CorePushesMain`, which names the need in their type. The
 * core's end is `core/push.ts`; the two share only the registry
 * (`contract/core/channels.ts`).
 *
 * One bus per main boot (`makeCorePushesMain`), in that boot's scope: when the
 * scope closes, every listener and every stream on it ends, and nothing more
 * is delivered.
 */
import { Context, Effect, Queue, Result, type Scope, Stream } from "effect";
import { CORE_PUSH_CHANNELS, decodeCorePush, type CorePushChannel, type CorePushOf } from "../../../contract/core/channels";

export class CorePushesMain extends Context.Service<CorePushesMain, {
  /** Each push on `channel`, decoded, until the returned stop or the bus's scope closes. */
  readonly subscribe: <K extends CorePushChannel>(channel: K, listener: (payload: CorePushOf<K>) => void) => () => void;
  /** Every push on `channel` from now on, none dropped; it ends with its consumer or the bus. */
  readonly changes: <K extends CorePushChannel>(channel: K) => Stream.Stream<CorePushOf<K>>;
}>()("@junto/app/CorePushesMain") {}

/** What feeds the bus: what the port carried, or main's own `coreRestarted`. Main-boot holds it, and no subscriber. */
export type DeliverCorePush = (channel: CorePushChannel, raw: unknown) => void;

type Listener = (payload: unknown) => void;

/** A bus for one main boot, and the one feed into it; both stop when the scope closes. */
export const makeCorePushesMain: Effect.Effect<
  { readonly pushes: CorePushesMain["Service"]; readonly deliver: DeliverCorePush },
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const listeners = new Map<CorePushChannel, Set<Listener>>();
  let open = true;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      open = false;
      listeners.clear();
    }),
  );

  const subscribe = <K extends CorePushChannel>(channel: K, listener: (payload: CorePushOf<K>) => void): (() => void) => {
    if (!open) return () => undefined;
    const set = listeners.get(channel) ?? new Set<Listener>();
    listeners.set(channel, set);
    // The map is keyed by channel: a listener here is read only under its own key.
    const held = listener as Listener;
    set.add(held);
    return () => {
      set.delete(held);
    };
  };

  const pushes = CorePushesMain.of({
    subscribe,
    changes: (channel) =>
      Stream.callback((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => subscribe(channel, (push) => Queue.offerUnsafe(queue, push))),
          (off) => Effect.sync(off),
        ),
      ),
  });

  /**
   * Hand one push to its subscribers, decoded closed with its channel's
   * Schema. A payload that does not decode is logged with its channel and
   * dropped: no subscriber, and so no window, ever reads it.
   */
  const deliver: DeliverCorePush = (channel, raw) => {
    if (!open) return;
    const decoded = decodeCorePush(channel, raw);
    if (Result.isFailure(decoded)) {
      console.error(`[core-pushes] dropped ${channel}: its payload does not match its Schema: ${decoded.failure.message}`);
      return;
    }
    for (const listener of [...(listeners.get(channel) ?? [])]) listener(decoded.success);
  };

  return { pushes, deliver };
});

// --- deprecated: the module bus ----------------------------------------------
// Until the hubs, the window link, observability, settings and the one-process
// test setup take CorePushesMain, main-boot bridges the bus into this one. It
// goes with them.

const moduleListeners = new Map<CorePushChannel, Set<Listener>>();

const fanOut = (channel: CorePushChannel, payload: unknown): void => {
  for (const listener of [...(moduleListeners.get(channel) ?? [])]) listener(payload);
};

/** @deprecated Read `CorePushesMain` from the context instead. */
export const subscribe = <K extends CorePushChannel>(
  channel: K,
  listener: (payload: CorePushOf<K>) => void,
): (() => void) => {
  const set = moduleListeners.get(channel) ?? new Set<Listener>();
  moduleListeners.set(channel, set);
  set.add(listener as Listener);
  return () => set.delete(listener as Listener);
};

/** @deprecated main-boot only: every push the bus hears, already decoded, reaches the module's subscribers too. */
export const bridgeModuleBus = (pushes: CorePushesMain["Service"]): (() => void) => {
  const stops = CORE_PUSH_CHANNELS.map((channel) => pushes.subscribe(channel, (payload) => fanOut(channel, payload)));
  return () => {
    for (const stop of stops) stop();
  };
};

/** @deprecated Tests only, until they feed a `makeCorePushesMain` bus: one push to the module's subscribers, decoded. */
export const deliverPush: DeliverCorePush = (channel, raw) => {
  const decoded = decodeCorePush(channel, raw);
  if (Result.isFailure(decoded)) {
    console.error(`[core-pushes] dropped ${channel}: its payload does not match its Schema: ${decoded.failure.message}`);
    return;
  }
  fanOut(channel, decoded.success);
};
