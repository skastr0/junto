/**
 * Main's side of the core's pushes. The core publishes on the channels the
 * registry names; main listens on the port for every one of them and
 * republishes it on this process's push bus, where the handlers that send to a
 * window already subscribe. The list is the registry, never a copy of it, so a
 * new push cannot be published without a window hearing it.
 */
import { CORE_PUSH_CHANNELS } from "../channels";
import { publishCarried } from "../push";

/**
 * Each push the core sent on the port reaches main's subscribers on the push
 * bus, as a publish in this process would. Returns the stop.
 */
export const relayWindowPushes = (client: { readonly onPush: (channel: string, listener: (payload: unknown) => void) => () => void }): (() => void) => {
  const stops = CORE_PUSH_CHANNELS.map((channel) => client.onPush(channel, (payload) => publishCarried(channel, payload)));
  return () => {
    for (const stop of stops) stop();
  };
};
