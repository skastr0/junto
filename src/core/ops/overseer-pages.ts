/**
 * The overseer in the core: main holds the browser and the window, so each
 * page operation is a call on main's host groups (src/contract/host/), and an
 * open keeps its recheck here under a call id main asks back before the page
 * commits (src/contract/core/overseer-pages.ts). A call the overseer abandons
 * is interrupted, and main aborts the page work it started for it.
 *
 * The call ids and the rechecks in flight belong to one core: its entry makes
 * one `OverseerPageFlights`, hands it to the host pages it composes and
 * provides it to the server that answers the recheck.
 */
import { Context, Effect } from "effect";
import type { RpcClientError } from "effect/rpc";
import type { PageTargetResult } from "../browser/page-target";
import type { ApplicationCaptureResult } from "../overseer/native";
import type { OverseerPages } from "../../node/overseer/pages";
import { OverseerPagesHost } from "../../contract/host/overseer-pages";
import { WindowHost } from "../../contract/host/window";
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

/** Runs a host call on the core's runtime; an abort of `signal` interrupts the call, and main aborts its side. */
export type HostRun = <A, E>(
  effect: Effect.Effect<A, E, OverseerPagesHost | WindowHost>,
  options?: { readonly signal?: AbortSignal },
) => Promise<A>;

type Pages = OverseerPagesHost["Service"];

const onPages = <A>(run: HostRun, use: (pages: Pages) => Effect.Effect<A, RpcClientError.RpcClientError>): Promise<A> =>
  run(
    Effect.gen(function* () {
      return yield* use(yield* OverseerPagesHost);
    }),
  );

/**
 * A call that waits on a page. The overseer's caller gave it a signal; once
 * that aborts, the call is interrupted, main aborts the page work, and the
 * answer is `cancelled` as data, as the browser answers its own cancelled work.
 */
const waiting = async <A>(
  run: HostRun,
  kind: string,
  signal: AbortSignal,
  use: (pages: Pages) => Effect.Effect<A, RpcClientError.RpcClientError>,
): Promise<A | { readonly ok: false; readonly code: "cancelled"; readonly message: string }> => {
  try {
    return await run(
      Effect.gen(function* () {
        return yield* use(yield* OverseerPagesHost);
      }),
      { signal },
    );
  } catch (error) {
    if (signal.aborted) return { ok: false, code: "cancelled", message: `${kind} cancelled` };
    throw error;
  }
};

const sent = (call: Promise<void>): void => {
  void call.catch((error: unknown) => console.error("[overseer] page fence not delivered:", error));
};

/** The core's side: the overseer's pages, each one a call to main, its call ids from this core's flights. */
export const hostOverseerPages = (run: HostRun, flights: OverseerPageFlights["Service"]): OverseerPages => ({
  sessionsForRef: (ref) => onPages(run, (pages) => pages.OverseerPagesSessionsForRef({ ref })),
  deleteSessionsForRef: (ref) => onPages(run, (pages) => pages.OverseerPagesDeleteSessionsForRef({ ref })),
  state: (owner, sessionId) => onPages(run, (pages) => pages.OverseerPagesState({ owner, sessionId })),
  open: async (input, recheck, signal) => {
    const callId = flights.nextCallId();
    const release = flights.hold(callId, recheck);
    try {
      return await waiting(run, "open", signal, (pages) => pages.OverseerPagesOpen({ callId, ...input }));
    } finally {
      release();
    }
  },
  goto: (owner, sessionId, url) => onPages(run, (pages) => pages.OverseerPagesGoto({ owner, sessionId, url })),
  eval: (owner, sessionId, code, signal) => waiting(run, "eval", signal, (pages) => pages.OverseerPagesEval({ owner, sessionId, code })),
  screenshot: (owner, sessionId, signal) => waiting(run, "screenshot", signal, (pages) => pages.OverseerPagesScreenshot({ owner, sessionId })),
  close: (owner, sessionId) => onPages(run, (pages) => pages.OverseerPagesClose({ owner, sessionId })),
  stop: (owner, sessionId) => onPages(run, (pages) => pages.OverseerPagesStop({ owner, sessionId })),
  beginDelete: (ref, leaseId) => sent(onPages(run, (pages) => pages.OverseerPagesBeginDelete({ ref, leaseId }))),
  finishDelete: (ref, leaseId) => sent(onPages(run, (pages) => pages.OverseerPagesFinishDelete({ ref, leaseId }))),
});

/** The core's side: the window's pixels, asked of main. */
export const hostCaptureApplicationPage = (run: HostRun) => (): Promise<ApplicationCaptureResult> =>
  run(
    Effect.gen(function* () {
      return yield* (yield* WindowHost).WindowCapturePage();
    }),
  );

/**
 * What the core's entry hands the core to compose its overseer: the host
 * pages and the window capture, given the runner of the core's own runtime.
 */
export const hostOverseer =
  (flights: OverseerPageFlights["Service"]) =>
  (run: HostRun) => ({
    captureApplicationPage: hostCaptureApplicationPage(run),
    pages: hostOverseerPages(run, flights),
  });
