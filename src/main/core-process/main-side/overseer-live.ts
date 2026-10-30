/**
 * Main's side of the live overseer: it runs in the core, so the window's live
 * controls reach it by name, and each snapshot change comes back on the push
 * bus once the core is asked to watch.
 */
import type { LiveAttention, LiveSnapshot, LiveStartInput, LiveStartResult } from "@shared/overseer-live";
import { LIVE_CHANGED } from "../channels";
import type { CoreClient } from "../client";
import { askOnEveryCore } from "../every-core";
import { subscribe } from "../push";
import type { LiveService } from "../ops/overseer-live";

/** The live overseer as the window's IPC reaches it in the core process. */
export const coreOverseerLive = (core: CoreClient): LiveService => ({
  liveStart: (input: LiveStartInput) => core.call("live.start", { input }),
  liveEnd: (sessionId) => core.call("live.end", { sessionId }),
  liveSnapshot: () => core.call("live.snapshot", {}),
  liveReady: (sessionId, connectionEpoch) => core.call("live.ready", { sessionId, connectionEpoch }),
  liveProviderEvent: (sessionId, connectionEpoch, event) => core.call("live.providerEvent", { sessionId, connectionEpoch, event }),
  liveAttention: (sessionId, attention: LiveAttention) => core.call("live.attention", { sessionId, attention }),
  liveCancel: (sessionId, requestId) => core.call("live.cancel", { sessionId, requestId }),
  liveSteer: (sessionId, requestId, text, attention: LiveAttention) => core.call("live.steer", { sessionId, requestId, text, attention }),
  liveStopActions: (sessionId) => core.call("live.stopActions", { sessionId }),
  subscribe: (listener) => {
    const stop = subscribe(LIVE_CHANGED, (snapshot) => listener(snapshot as LiveSnapshot));
    askOnEveryCore("live.watch", () => core.call("live.watch", {}));
    return () => {
      stop();
    };
  },
});
