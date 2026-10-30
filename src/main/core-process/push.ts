/**
 * Changes the core announces to Electron main, by channel (Wave 3). A core
 * service publishes; main subscribes once per channel and forwards to the
 * renderer. Today both ends run in main and a publish calls the subscribers
 * at once; when the core moves into its own process, `publish` posts on the
 * core port (`serveCore(...).push`) and main's subscriptions listen on it
 * (`portCore(...).onPush`), in the same order.
 */
type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
let forward: ((channel: string, payload: unknown) => void) | undefined;

export const publish = (channel: string, payload: unknown): void => {
  if (forward !== undefined) return forward(channel, payload);
  for (const listener of listeners.get(channel) ?? []) listener(payload);
};

export const subscribe = (channel: string, listener: Listener): (() => void) => {
  const set = listeners.get(channel) ?? new Set<Listener>();
  listeners.set(channel, set);
  set.add(listener);
  return () => set.delete(listener);
};

/** In the core process: send every publish over the port instead. */
export const forwardPublishes = (send: (channel: string, payload: unknown) => void): void => {
  forward = send;
};
