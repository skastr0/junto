/**
 * Main's side of the live overseer: it runs in the core, so the window's live
 * controls are calls of the core's live overseer group
 * (src/contract/core/overseer-live.ts), and each snapshot change comes back
 * on the push bus, which every core sends from its start.
 */
import { Context } from "effect";
import { LIVE_CHANGED } from "../../../contract/core/channels";
import { OverseerLiveCore } from "../../../contract/core/overseer-live";
import type { LiveService } from "../../../core/ops/overseer-live";
import { AppRuntime } from "../../runtime";
import { subscribe } from "./core-pushes";

/** The live overseer as the window's IPC reaches it in the core process. */
export const coreOverseerLive = (core: Context.Context<OverseerLiveCore>): LiveService => {
  const live = Context.get(core, OverseerLiveCore);
  return {
    liveStart: (input) => AppRuntime.runPromise(live.OverseerLiveStart({ input })),
    liveEnd: (sessionId) => AppRuntime.runPromise(live.OverseerLiveEnd({ sessionId })),
    liveSnapshot: () => AppRuntime.runPromise(live.OverseerLiveSnapshot()),
    liveReady: (sessionId, connectionEpoch) => AppRuntime.runPromise(live.OverseerLiveReady({ sessionId, connectionEpoch })),
    liveProviderEvent: (sessionId, connectionEpoch, event) =>
      AppRuntime.runPromise(live.OverseerLiveProviderEvent({ sessionId, connectionEpoch, event })),
    liveAttention: (sessionId, attention) => AppRuntime.runPromise(live.OverseerLiveAttention({ sessionId, attention })),
    liveCancel: (sessionId, requestId) => AppRuntime.runPromise(live.OverseerLiveCancel({ sessionId, requestId })),
    liveSteer: (sessionId, requestId, text, attention) =>
      AppRuntime.runPromise(live.OverseerLiveSteer({ sessionId, requestId, text, attention })),
    liveStopActions: (sessionId) => AppRuntime.runPromise(live.OverseerLiveStopActions({ sessionId })),
    subscribe: (listener) => subscribe(LIVE_CHANGED, listener),
  };
};
