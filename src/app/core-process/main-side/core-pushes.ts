/**
 * Main's end of the push channels (Wave 3): what the core announced, heard in
 * main. The port relay (`window-pushes.ts`) delivers each push the core sent;
 * the handlers that send to a window subscribe here. The core's end is
 * `core-process/push.ts`; the two share only the registry (`channels.ts`).
 */
import { Result } from "effect";
import { decodeCorePush, type CorePushChannel, type CorePushOf } from "../../../contract/core/channels";

type Listener = (payload: unknown) => void;
const listeners = new Map<CorePushChannel, Set<Listener>>();

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

/**
 * Hand one push to its subscribers: what the port carried, or main's own
 * `coreRestarted`, decoded closed with its channel's Schema. A payload that
 * does not decode is logged with its channel and dropped: no subscriber, and
 * so no window, ever reads it.
 */
export const deliverPush = (channel: CorePushChannel, raw: unknown): void => {
  const decoded = decodeCorePush(channel, raw);
  if (Result.isFailure(decoded)) {
    console.error(`[core-pushes] dropped ${channel}: its payload does not match its Schema: ${decoded.failure.message}`);
    return;
  }
  for (const listener of listeners.get(channel) ?? []) listener(decoded.success);
};
