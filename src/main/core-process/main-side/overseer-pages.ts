/**
 * Main's side of the overseer: the core runs the overseer and asks main for
 * each page operation and for the window's pixels by host operation. An open
 * keeps one function, its recheck, on the core side under a call id: main
 * asks it back by core operation before the page commits. The same id carries
 * an abort from the core's signal to main's.
 */
import type { BrowserStopReceipt } from "@shared/browser";
import type { BrowserSessionInfo } from "@shared/ipc";
import type { PageTargetResult, ResolvedPageTarget } from "../../junto/browser/page-target";
import type { BrowserResult } from "../../junto/browser/sessions";
import type { ApplicationCaptureResult } from "../../junto/overseer/native";
import type { OverseerPages, OverseerPageSession } from "../../junto/overseer/pages";
import type { CoreClient } from "../client";
import { hostOps, type HostOp } from "../host-ops";

type Session = { readonly owner: string; readonly sessionId: string };
type Signalled = { readonly callId: number };

declare module "../host-ops" {
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
 * Main's side: answer the core's page and window asks on what main holds now.
 * `pages` is read on every call, since the browser binds after the core boots.
 */
export const serveOverseerHost = (input: {
  readonly core: CoreClient;
  readonly pages: () => OverseerPages | undefined;
  readonly captureApplicationPage: () => Promise<ApplicationCaptureResult>;
}): (() => void) => {
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
  return hostOps({
    "window.capturePage": () => input.captureApplicationPage(),
    "overseer.pages.sessionsForRef": async ({ ref }) => (await input.pages()?.sessionsForRef(ref)) ?? [],
    "overseer.pages.deleteSessionsForRef": async ({ ref }) => (await input.pages()?.deleteSessionsForRef(ref)) ?? [],
    "overseer.pages.state": ({ owner, sessionId }) => on((pages) => pages.state(owner, sessionId)),
    "overseer.pages.open": ({ callId, ...open }) =>
      flight(callId, (signal) =>
        on((pages) => pages.open(open, () => input.core.call("overseer.pages.recheck", { callId }), signal))),
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
};
