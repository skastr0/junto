import { Effect } from "effect";
import type { PageTargetResult } from "../../junto/browser/page-target";
import type { ApplicationCaptureResult } from "../../junto/overseer/native";
import type { OverseerPages, OverseerPageSession } from "../../junto/overseer/pages";
import type { HostClient } from "../host-ops";
import { coreOps, type CoreOp } from "../ops";

/**
 * The overseer in the core: main holds the browser and the window, so each
 * page operation is a host call, and an open keeps its recheck here under a
 * call id main can ask back before the page commits.
 */

type Session = { readonly owner: string; readonly sessionId: string };
type Signalled = { readonly callId: number };

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
