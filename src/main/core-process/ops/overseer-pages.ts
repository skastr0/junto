import { Effect } from "effect";
import type { BrowserStopReceipt } from "@shared/browser";
import type { BrowserSessionInfo } from "@shared/ipc";
import type { PageTargetResult, ResolvedPageTarget } from "../../junto/browser/page-target";
import type { BrowserResult } from "../../junto/browser/sessions";
import type { ApplicationCaptureResult } from "../../junto/overseer/native";
import type { OverseerPages, OverseerPageSession } from "../../junto/overseer/pages";
import type { CoreClient } from "../client";
import { hostOps, type HostClient, type HostOp } from "../host-ops";
import { coreOps, type CoreOp } from "../ops";

/**
 * The overseer in the core, the browser and the window in main. The core
 * asks main for each page operation and for the window's pixels by host
 * operation. An open keeps one function, its recheck, on the core side under
 * a call id: main asks it back by core operation before the page commits.
 * The same id carries an abort from the core's signal to main's.
 */

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

declare module "../ops" {
  interface CoreOps {
    "overseer.pages.recheck": CoreOp<Signalled, PageTargetResult>;
  }
}

const rechecks = new Map<number, () => Promise<PageTargetResult>>();
let nextCallId = 1;

coreOps({
  "overseer.pages.recheck": ({ callId }) =>
    Effect.promise((): Promise<PageTargetResult> => {
      const recheck = rechecks.get(callId);
      return recheck === undefined
        ? Promise.resolve({ ok: false, code: "failed", message: "overseer page open is no longer in flight" })
        : recheck();
    }),
});

/** Keeps `signal` with main for the call's life: an abort here aborts main's side by the same id. */
const signalled = async <A>(host: HostClient, signal: AbortSignal, call: (callId: number) => Promise<A>): Promise<A> => {
  const callId = nextCallId++;
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

/** The core's side: the overseer's pages, each one a host call to main. */
export const hostOverseerPages = (host: HostClient): OverseerPages => ({
  sessionsForRef: (ref) => host.call("overseer.pages.sessionsForRef", { ref }),
  deleteSessionsForRef: (ref) => host.call("overseer.pages.deleteSessionsForRef", { ref }),
  state: (owner, sessionId) => host.call("overseer.pages.state", { owner, sessionId }),
  open: (input, recheck, signal) =>
    signalled(host, signal, async (callId) => {
      rechecks.set(callId, recheck);
      try {
        return await host.call("overseer.pages.open", { callId, ...input });
      } finally {
        rechecks.delete(callId);
      }
    }),
  goto: (owner, sessionId, url) => host.call("overseer.pages.goto", { owner, sessionId, url }),
  eval: (owner, sessionId, code, signal) =>
    signalled(host, signal, (callId) => host.call("overseer.pages.eval", { callId, owner, sessionId, code })),
  screenshot: (owner, sessionId, signal) =>
    signalled(host, signal, (callId) => host.call("overseer.pages.screenshot", { callId, owner, sessionId })),
  close: (owner, sessionId) => host.call("overseer.pages.close", { owner, sessionId }),
  stop: (owner, sessionId) => host.call("overseer.pages.stop", { owner, sessionId }),
  beginDelete: (ref, leaseId) => sent(host.call("overseer.pages.beginDelete", { ref, leaseId })),
  finishDelete: (ref, leaseId) => sent(host.call("overseer.pages.finishDelete", { ref, leaseId })),
});

/** The core's side: the window's pixels, asked of main. */
export const hostCaptureApplicationPage = (host: HostClient) => (): Promise<ApplicationCaptureResult> =>
  host.call("window.capturePage", {});

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
