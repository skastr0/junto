/**
 * Main's side of the overseer: the core runs the overseer and asks main, on
 * the host groups (src/contract/host/overseer-pages.ts, window.ts), for each
 * page operation and for the window's pixels. An open keeps one function, its
 * recheck, on the core side under a call id: main asks it back through the
 * core's overseer pages group (src/contract/core/overseer-pages.ts) before
 * the page commits.
 *
 * A call the core abandons, or a core that exits, interrupts the handler
 * serving it, and the page work it started aborts with it.
 */
import { Context, Effect, Layer } from "effect";
import type { BrowserResult } from "../../browser/sessions";
import type { ApplicationCaptureResult } from "../../../core/overseer/native";
import type { OverseerPages } from "../../../node/overseer/pages";
import { CoreLink } from "../../../contract/core/link";
import { OverseerPagesCore } from "../../../contract/core/overseer-pages";
import type { RpcPort } from "@shared/rpc-port";
import { OverseerPagesHostRpcs } from "../../../contract/host/overseer-pages";
import { WindowHostRpcs } from "../../../contract/host/window";
import type { PageTargetResult } from "../../../core/browser/page-target";

/**
 * The browser's overseer pages, read on every call, since the browser binds
 * after the core boots; and the runner an open's recheck is asked back on,
 * which is main's own runtime.
 */
export class OverseerBrowser extends Context.Service<
  OverseerBrowser,
  {
    readonly pages: () => OverseerPages | undefined;
    readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  }
>()("@junto/app/OverseerBrowser") {}

/** The application window's pixels, as main takes them. */
export class ApplicationCapture extends Context.Service<
  ApplicationCapture,
  { readonly capture: () => Promise<ApplicationCaptureResult> }
>()("@junto/app/ApplicationCapture") {}

/** What the overseer and window handlers need from main, given once main has them. */
export const overseerHostServices = (input: {
  /** The browser the overseer drives, once the browser composition bound it. */
  readonly pages: () => OverseerPages | undefined;
  readonly captureApplicationPage: () => Promise<ApplicationCaptureResult>;
  /** The link the core's groups ride: an open's recheck goes back on it. */
  readonly coreLink: RpcPort;
  /** Main's runtime: the recheck is asked on it. */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}) =>
  Layer.mergeAll(
    Layer.succeed(OverseerBrowser, { pages: input.pages, run: input.run }),
    Layer.succeed(ApplicationCapture, { capture: input.captureApplicationPage }),
    OverseerPagesCore.layer.pipe(Layer.provide(Layer.succeed(CoreLink, input.coreLink))),
  );

const unavailable = { ok: false, code: "failed", message: "browser runtime is unavailable on this installation" } as const;

export const OverseerPagesHostHandlers = OverseerPagesHostRpcs.toLayer(
  Effect.gen(function* () {
    const { pages, run } = yield* OverseerBrowser;
    const core = yield* OverseerPagesCore;
    const recheck = (callId: number): Promise<PageTargetResult> =>
      run(core.OverseerPagesRecheck({ callId }));
    /** A page operation: its signal aborts with the call. */
    const on = <A>(use: (pages: OverseerPages, signal: AbortSignal) => Promise<BrowserResult<A>>) =>
      Effect.promise((signal) => {
        const current = pages();
        return current === undefined ? Promise.resolve(unavailable) : use(current, signal);
      });
    return {
      OverseerPagesSessionsForRef: ({ ref }) => Effect.promise(async () => (await pages()?.sessionsForRef(ref)) ?? []),
      OverseerPagesDeleteSessionsForRef: ({ ref }) => Effect.promise(async () => (await pages()?.deleteSessionsForRef(ref)) ?? []),
      OverseerPagesState: ({ owner, sessionId }) => on((current) => current.state(owner, sessionId)),
      OverseerPagesOpen: ({ callId, ...open }) => on((current, signal) => current.open(open, () => recheck(callId), signal)),
      OverseerPagesGoto: ({ owner, sessionId, url }) => on((current) => current.goto(owner, sessionId, url)),
      OverseerPagesEval: ({ owner, sessionId, code }) => on((current, signal) => current.eval(owner, sessionId, code, signal)),
      OverseerPagesScreenshot: ({ owner, sessionId }) => on((current, signal) => current.screenshot(owner, sessionId, signal)),
      OverseerPagesClose: ({ owner, sessionId }) => on((current) => current.close(owner, sessionId)),
      OverseerPagesStop: ({ owner, sessionId }) => on((current) => current.stop(owner, sessionId)),
      OverseerPagesBeginDelete: ({ ref, leaseId }) =>
        Effect.sync(() => {
          pages()?.beginDelete(ref, leaseId);
        }),
      OverseerPagesFinishDelete: ({ ref, leaseId }) =>
        Effect.sync(() => {
          pages()?.finishDelete(ref, leaseId);
        }),
    };
  }),
);

export const WindowHostHandlers = WindowHostRpcs.toLayer(
  Effect.gen(function* () {
    const { capture } = yield* ApplicationCapture;
    return { WindowCapturePage: () => Effect.promise(capture) };
  }),
);
