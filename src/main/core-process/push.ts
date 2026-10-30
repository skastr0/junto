/**
 * Changes the core announces, by channel (Wave 3). A core service publishes;
 * main listens on the core port for every channel in the registry
 * (`channels.ts`) and republishes here, where the handlers that send to a
 * window subscribe. In the core, `publish` posts on the port
 * (`serveCore(...).push`); in main it calls this process's subscribers.
 *
 * The registry types both ends: a channel not in it does not compile, and a
 * payload that is not that channel's does not compile either.
 */
import type { CorePushChannel, CorePushOf } from "./channels";

type Listener = (payload: unknown) => void;
const listeners = new Map<CorePushChannel, Set<Listener>>();
let forward: ((channel: CorePushChannel, payload: unknown) => void) | undefined;

export const publish = <K extends CorePushChannel>(channel: K, payload: CorePushOf<K>): void => {
  if (forward !== undefined) return forward(channel, payload);
  for (const listener of listeners.get(channel) ?? []) listener(payload);
};

export const subscribe = <K extends CorePushChannel>(
  channel: K,
  listener: (payload: CorePushOf<K>) => void,
): (() => void) => {
  const set = listeners.get(channel) ?? new Set<Listener>();
  listeners.set(channel, set);
  // The map is keyed by channel: a listener here is read only under its own key.
  set.add(listener as Listener);
  return () => set.delete(listener as Listener);
};

/** Publish the given channel on this bus. The port hands over what it carried. */
export const publishCarried = (channel: CorePushChannel, payload: unknown): void => {
  if (forward !== undefined) return forward(channel, payload);
  for (const listener of listeners.get(channel) ?? []) listener(payload);
};

/** In the core process: send every publish over the port instead. */
export const forwardPublishes = (send: (channel: CorePushChannel, payload: unknown) => void): void => {
  forward = send;
};
