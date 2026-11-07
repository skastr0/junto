/**
 * Main's side of the overseer: the core runs the overseer and asks main for
 * each page operation and for the window's pixels by host operation. An open
 * keeps one function, its recheck, on the core side under a call id: main
 * asks it back through the core's overseer pages group
 * (src/contract/core/overseer-pages.ts) before the page commits. The same id
 * carries an abort from the core's signal to main's.
 */
import { Context, Effect, Exit, Layer, Scope } from "effect";
import type { BrowserStopReceipt } from "@shared/browser";
import type { BrowserSessionInfo } from "@shared/ipc";
import type { PageTargetResult, ResolvedPageTarget } from "../../../core/browser/page-target";
import type { BrowserResult } from "../../browser/sessions";
import type { ApplicationCaptureResult } from "../../../core/overseer/native";
import type { OverseerPages, OverseerPageSession } from "../../../node/overseer/pages";
import { CoreLink } from "../../../contract/core/link";
import { OverseerPagesCore } from "../../../contract/core/overseer-pages";
import type { RpcPort } from "@shared/rpc-port";
import { AppRuntime } from "../../runtime";
import type { HostOp } from "../../../core/host-ops";
import { hostOps } from "./host-op-bodies";

type Session = { readonly owner: string; readonly sessionId: string };
type Signalled = { readonly callId: number };

declare module "../../../core/host-ops" {
  interface HostOps {
    "window.capturePage": HostOp<Record<string, never>, ApplicationCaptureResult>;
    "overseer.pages.sessionsForRef": HostOp<{ readonly ref: string }, ReadonlyArray<OverseerPageSession>>;
    "overseer.pages.deleteSessionsForRef": HostOp<{ readonly ref: string }, ReadonlyArray<OverseerPageSession>>;
    "overseer.pages.state": HostOp<Session, BrowserResult<BrowserSessionInfo>>;
    "overseer.pages.open": HostOp<
      Signalled & { readonly owner: string; readonly target: ResolvedPageTarget; readonly driver: string },
      BrowserResult<BrowserSessionInfo>
    >;
    "overseer.pages.goto": HostOp<Session & { readonly url: string }, BrowserResult<BrowserSessionInfo>>;
    "overseer.pages.eval": HostOp<Signalled & Session & { readonly code: string }, BrowserResult<{ result: unknown }>>;
    "overseer.pages.screenshot": HostOp<Signalled & Session, BrowserResult<{ png: Uint8Array }>>;
    "overseer.pages.close": HostOp<Session, BrowserResult<BrowserSessionInfo>>;
    "overseer.pages.stop": HostOp<Session, BrowserResult<BrowserStopReceipt>>;
    "overseer.pages.beginDelete": HostOp<{ readonly ref: string; readonly leaseId: string }, void>;
    "overseer.pages.finishDelete": HostOp<{ readonly ref: string; readonly leaseId: string }, void>;
    "overseer.pages.abort": HostOp<Signalled, void>;
  }
}

const unavailable = { ok: false, code: "failed", message: "browser runtime is unavailable on this installation" } as const;

/**
 * Main's client of the overseer pages group on the link to the core, for as
 * long as main serves the overseer: built at once, closed at stop.
 */
const pagesClientOn = (link: RpcPort) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const clients = yield* Layer.buildWithScope(OverseerPagesCore.layer.pipe(Layer.provide(Layer.succeed(CoreLink, link))), scope);
      return { scope, pages: Context.get(clients, OverseerPagesCore) };
    }),
  );

/**
 * Main's side: answer the core's page and window asks on what main holds now.
 * `pages` is read on every call, since the browser binds after the core boots.
 */
export const serveOverseerHost = (input: {
  /** The link the core's groups ride; the recheck of an open goes back on it. */
  readonly link: RpcPort;
  readonly pages: () => OverseerPages | undefined;
  readonly captureApplicationPage: () => Promise<ApplicationCaptureResult>;
}): (() => void) => {
  const client = pagesClientOn(input.link);
  const recheck = (callId: number): Promise<PageTargetResult> =>
    client.then(({ pages }) => AppRuntime.runPromise(pages.OverseerPagesRecheck({ callId })));
  const flights = new Map<number, AbortController>();
  const flight = async <A>(callId: number, body: (signal: AbortSignal) => Promise<A>): Promise<A> => {
    const controller = new AbortController();
    flights.set(callId, controller);
    try {
      return await body(controller.signal);
    } finally {
      flights.delete(callId);
    }
  };
  const on = <A>(use: (pages: OverseerPages) => Promise<BrowserResult<A>>): Promise<BrowserResult<A>> => {
    const pages = input.pages();
    return pages === undefined ? Promise.resolve(unavailable) : use(pages);
  };
  const stopHost = hostOps({
    "window.capturePage": () => input.captureApplicationPage(),
    "overseer.pages.sessionsForRef": async ({ ref }) => (await input.pages()?.sessionsForRef(ref)) ?? [],
    "overseer.pages.deleteSessionsForRef": async ({ ref }) => (await input.pages()?.deleteSessionsForRef(ref)) ?? [],
    "overseer.pages.state": ({ owner, sessionId }) => on((pages) => pages.state(owner, sessionId)),
    "overseer.pages.open": ({ callId, ...open }) =>
      flight(callId, (signal) =>
        on((pages) => pages.open(open, () => recheck(callId), signal))),
    "overseer.pages.goto": ({ owner, sessionId, url }) => on((pages) => pages.goto(owner, sessionId, url)),
    "overseer.pages.eval": ({ callId, owner, sessionId, code }) =>
      flight(callId, (signal) => on((pages) => pages.eval(owner, sessionId, code, signal))),
    "overseer.pages.screenshot": ({ callId, owner, sessionId }) =>
      flight(callId, (signal) => on((pages) => pages.screenshot(owner, sessionId, signal))),
    "overseer.pages.close": ({ owner, sessionId }) => on((pages) => pages.close(owner, sessionId)),
    "overseer.pages.stop": ({ owner, sessionId }) => on((pages) => pages.stop(owner, sessionId)),
    "overseer.pages.beginDelete": async ({ ref, leaseId }) => input.pages()?.beginDelete(ref, leaseId),
    "overseer.pages.finishDelete": async ({ ref, leaseId }) => input.pages()?.finishDelete(ref, leaseId),
    "overseer.pages.abort": async ({ callId }) => flights.get(callId)?.abort(),
  });
  return () => {
    stopHost();
    void client.then(({ scope }) => AppRuntime.runPromise(Scope.close(scope, Exit.void)));
  };
};
