import { Effect } from "effect";
import type { LiveAttention, LiveSnapshot, LiveStartInput, LiveStartResult, OverseerLiveApi } from "@shared/overseer-live";
import { LIVE_CHANGED } from "../channels";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";

/**
 * The live overseer runs in the core; the window's live controls reach it by
 * name, and each snapshot change comes back on the push stream.
 */

export type LiveService = Omit<OverseerLiveApi, "onLiveChanged"> & {
  readonly subscribe: (listener: (snapshot: LiveSnapshot) => void) => () => void;
};
type Session = { readonly sessionId: string };

declare module "../ops" {
  interface CoreOps {
    "live.start": CoreOp<{ readonly input: LiveStartInput }, LiveStartResult>;
    "live.end": CoreOp<Session, LiveSnapshot>;
    "live.snapshot": CoreOp<Record<string, never>, LiveSnapshot>;
    "live.ready": CoreOp<Session & { readonly connectionEpoch: number }, void>;
    "live.providerEvent": CoreOp<Session & { readonly connectionEpoch: number; readonly event: unknown }, void>;
    "live.attention": CoreOp<Session & { readonly attention: LiveAttention }, void>;
    "live.cancel": CoreOp<Session & { readonly requestId: string }, LiveSnapshot>;
    "live.steer": CoreOp<Session & { readonly requestId: string; readonly text: string; readonly attention: LiveAttention }, LiveSnapshot>;
    "live.stopActions": CoreOp<Session, LiveSnapshot>;
    "live.watch": CoreOp<Record<string, never>, void>;
  }
}

let bound: LiveService | undefined;
let watching = false;

/** Core boot only: the live overseer this core composed. */
export const bindOverseerLive = (service: LiveService | undefined): void => {
  bound = service;
};

const live = <A>(use: (service: LiveService) => Promise<A>) =>
  Effect.tryPromise(() => (bound === undefined ? Promise.reject(new Error("the live overseer is not running in this core")) : use(bound)));

coreOps({
  "live.start": ({ input }) => live((service) => service.liveStart(input)),
  "live.end": ({ sessionId }) => live((service) => service.liveEnd(sessionId)),
  "live.snapshot": () => live((service) => service.liveSnapshot()),
  "live.ready": ({ sessionId, connectionEpoch }) => live((service) => service.liveReady(sessionId, connectionEpoch)),
  "live.providerEvent": ({ sessionId, connectionEpoch, event }) =>
    live((service) => service.liveProviderEvent(sessionId, connectionEpoch, event)),
  "live.attention": ({ sessionId, attention }) => live((service) => service.liveAttention(sessionId, attention)),
  "live.cancel": ({ sessionId, requestId }) => live((service) => service.liveCancel(sessionId, requestId)),
  "live.steer": ({ sessionId, requestId, text, attention }) => live((service) => service.liveSteer(sessionId, requestId, text, attention)),
  "live.stopActions": ({ sessionId }) => live((service) => service.liveStopActions(sessionId)),
  // Subscribed once per core.
  "live.watch": () =>
    live(async (service) => {
      if (watching) return;
      watching = true;
      service.subscribe((snapshot) => publish(LIVE_CHANGED, snapshot));
    }),
});
