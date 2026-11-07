/**
 * The overseer in the core: main holds the browser and the window, so each
 * page operation is a host call, and an open keeps its recheck here under a
 * call id main asks back before the page commits
 * (src/contract/core/overseer-pages.ts).
 *
 * The call ids and the rechecks in flight belong to one core: its entry makes
 * one `OverseerPageFlights`, hands it to the host pages it composes and
 * provides it to the server that answers the recheck.
 */
import { Context, Effect } from "effect";
import type { PageTargetResult } from "../browser/page-target";
import type { ApplicationCaptureResult } from "../overseer/native";
import type { OverseerPages } from "../../node/overseer/pages";
import type { HostClient } from "../host-ops";
import { OverseerPagesRpcs } from "../../contract/core/overseer-pages";

type Recheck = () => Promise<PageTargetResult>;

/** One core's overseer page calls: the id each signalled call goes out under, and each open's recheck while it is in flight. */
export class OverseerPageFlights extends Context.Service<
  OverseerPageFlights,
  {
    /** A call id no other call of this core has had. */
    readonly nextCallId: () => number;
    /** Keep `recheck` under `callId` until the returned release runs. */
    readonly hold: (callId: number, recheck: Recheck) => () => void;
    /** The recheck under `callId`, if that open is still in flight. */
    readonly recheckOf: (callId: number) => Recheck | undefined;
  }
>()("@junto/core/OverseerPageFlights") {
  /** Core boot only: this core's flights, empty. */
  static readonly make = (): OverseerPageFlights["Service"] => {
    const rechecks = new Map<number, Recheck>();
    let next = 1;
    return {
      nextCallId: () => next++,
      hold: (callId, recheck) => {
        rechecks.set(callId, recheck);
        return () => {
          rechecks.delete(callId);
        };
      },
      recheckOf: (callId) => rechecks.get(callId),
    };
  };
}

const gone: PageTargetResult = { ok: false, code: "failed", message: "overseer page open is no longer in flight" };

export const OverseerPagesHandlers = OverseerPagesRpcs.toLayer(
  Effect.gen(function* () {
    const flights = yield* OverseerPageFlights;
    return {
      OverseerPagesRecheck: ({ callId }) => {
        const recheck = flights.recheckOf(callId);
        if (recheck === undefined) return Effect.succeed(gone);
        // A recheck that throws refuses the open; main reads the refusal as the page not committing.
        return Effect.tryPromise(recheck).pipe(
          Effect.catch((cause) =>
            Effect.succeed<PageTargetResult>({ ok: false, code: "failed", message: cause instanceof Error ? cause.message : String(cause) }),
          ),
        );
      },
    };
  }),
);

/** Keeps `signal` with main for the call's life: an abort here aborts main's side by the same id. */
const signalled = async <A>(
  host: HostClient,
  flights: OverseerPageFlights["Service"],
  signal: AbortSignal,
  call: (callId: number) => Promise<A>,
): Promise<A> => {
  const callId = flights.nextCallId();
  const abort = (): void => {
    void host.call("overseer.pages.abort", { callId }).catch(() => undefined);
  };
  // The call goes out first, so main holds its flight before any abort for it arrives.
  const answer = call(callId);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    return await answer;
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

const sent = (call: Promise<void>): void => {
  void call.catch((error: unknown) => console.error("[overseer] page fence not delivered:", error));
};

/** The core's side: the overseer's pages, each one a host call to main, its call ids from this core's flights. */
export const hostOverseerPages = (host: HostClient, flights: OverseerPageFlights["Service"]): OverseerPages => ({
  sessionsForRef: (ref) => host.call("overseer.pages.sessionsForRef", { ref }),
  deleteSessionsForRef: (ref) => host.call("overseer.pages.deleteSessionsForRef", { ref }),
  state: (owner, sessionId) => host.call("overseer.pages.state", { owner, sessionId }),
  open: (input, recheck, signal) =>
    signalled(host, flights, signal, async (callId) => {
      const release = flights.hold(callId, recheck);
      try {
        return await host.call("overseer.pages.open", { callId, ...input });
      } finally {
        release();
      }
    }),
  goto: (owner, sessionId, url) => host.call("overseer.pages.goto", { owner, sessionId, url }),
  eval: (owner, sessionId, code, signal) =>
    signalled(host, flights, signal, (callId) => host.call("overseer.pages.eval", { callId, owner, sessionId, code })),
  screenshot: (owner, sessionId, signal) =>
    signalled(host, flights, signal, (callId) => host.call("overseer.pages.screenshot", { callId, owner, sessionId })),
  close: (owner, sessionId) => host.call("overseer.pages.close", { owner, sessionId }),
  stop: (owner, sessionId) => host.call("overseer.pages.stop", { owner, sessionId }),
  beginDelete: (ref, leaseId) => sent(host.call("overseer.pages.beginDelete", { ref, leaseId })),
  finishDelete: (ref, leaseId) => sent(host.call("overseer.pages.finishDelete", { ref, leaseId })),
});

/** The core's side: the window's pixels, asked of main. */
export const hostCaptureApplicationPage = (host: HostClient) => (): Promise<ApplicationCaptureResult> =>
  host.call("window.capturePage", {});
