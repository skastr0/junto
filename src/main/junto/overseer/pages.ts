import type { BrowserStopReceipt } from "@shared/browser";
import type { BrowserSessionInfo } from "@shared/ipc";
import { asNodeId } from "@shared/model";
import type { ResolvedPageTarget } from "../browser/page-target";
import { pageOriginGuard, type BrowserResult, type BrowserSessionService, type BrowserTargetRevalidator } from "../browser/sessions";

/** A live page session, as the overseer names one. */
export type OverseerPageSession = { readonly owner: string; readonly sessionId: string };

/**
 * The browser as the overseer uses it: every page operation it runs and the
 * fence a node delete holds over a page. Each answer is data and each call
 * may cross a process, so the overseer runs where the core does and the
 * pages stay in Electron main. A fence begin or finish is sent, not awaited
 * for an answer: calls reach the browser in the order they were made.
 */
export interface OverseerPages {
  readonly sessionsForRef: (ref: string) => Promise<ReadonlyArray<OverseerPageSession>>;
  readonly deleteSessionsForRef: (ref: string) => Promise<ReadonlyArray<OverseerPageSession>>;
  readonly state: (owner: string, sessionId: string) => Promise<BrowserResult<BrowserSessionInfo>>;
  /** Opens `target` for `owner`, asking `recheck` again before the page commits; top-level stays on its origin. */
  readonly open: (
    input: { readonly owner: string; readonly target: ResolvedPageTarget; readonly driver: string },
    recheck: BrowserTargetRevalidator,
    signal: AbortSignal,
  ) => Promise<BrowserResult<BrowserSessionInfo>>;
  readonly goto: (owner: string, sessionId: string, url: string) => Promise<BrowserResult<BrowserSessionInfo>>;
  readonly eval: (owner: string, sessionId: string, code: string, signal: AbortSignal) => Promise<BrowserResult<{ result: unknown }>>;
  readonly screenshot: (owner: string, sessionId: string, signal: AbortSignal) => Promise<BrowserResult<{ png: Uint8Array }>>;
  readonly close: (owner: string, sessionId: string) => Promise<BrowserResult<BrowserSessionInfo>>;
  readonly stop: (owner: string, sessionId: string) => Promise<BrowserResult<BrowserStopReceipt>>;
  readonly beginDelete: (ref: string, leaseId: string) => void;
  readonly finishDelete: (ref: string, leaseId: string) => void;
}

/** The overseer's pages on the browser sessions in this process. */
export const overseerPagesOn = (sessions: BrowserSessionService): OverseerPages => ({
  sessionsForRef: async (ref) => [...sessions.overseerSessionsForRef(ref)],
  deleteSessionsForRef: async (ref) => [...sessions.overseerDeleteSessionsForRef(ref)],
  state: async (owner, sessionId) => sessions.stateForOwner(owner, sessionId),
  open: ({ owner, target, driver }, recheck, signal) =>
    sessions.openForOwner(owner, target, signal, recheck, pageOriginGuard(target.url), undefined, asNodeId(driver)),
  goto: async (owner, sessionId, url) => sessions.gotoForOwner(owner, sessionId, url),
  eval: (owner, sessionId, code, signal) => sessions.evalForOwner(owner, sessionId, code, signal),
  screenshot: (owner, sessionId, signal) => sessions.screenshotForOwner(owner, sessionId, signal),
  close: async (owner, sessionId) => sessions.closeForOwner(owner, sessionId),
  stop: (owner, sessionId) => sessions.stopForOwner(owner, sessionId),
  beginDelete: (ref, leaseId) => sessions.beginOverseerPageDelete(ref, leaseId),
  finishDelete: (ref, leaseId) => sessions.finishOverseerPageDelete(ref, leaseId),
});
