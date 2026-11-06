/**
 * The core's end of the push channels (Wave 3): a core service announces a
 * change by channel, and it leaves on the core's one port to main. Main's end
 * is `main-side/core-pushes.ts`; the two share only the registry
 * (`channels.ts`), which types both: a channel not in it does not compile, and
 * a payload that is not that channel's does not compile either.
 *
 * Only the core loads this module. Its entry sends pushes on its port; a
 * windowless core, which has no window to hear them, says so and sends them
 * nowhere. A publish before either is a boot-order bug, so it throws.
 */
import type { CorePushChannel, CorePushOf } from "./channels";

type Send = (channel: CorePushChannel, payload: unknown) => void;

let send: Send | undefined;

export const publish = <K extends CorePushChannel>(channel: K, payload: CorePushOf<K>): void => {
  if (send === undefined) throw new Error(`Junto core published ${channel} before its boot chose where pushes go`);
  send(channel, payload);
};

/** Core boot only: where every publish goes from now on. */
export const sendPushesTo = (next: Send): void => {
  send = next;
};
