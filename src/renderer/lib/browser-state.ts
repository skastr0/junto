import { observable } from "@legendapp/state";
import type { BrowserSessionInfo, VellumBrowserApi } from "@shared/ipc";
import { parseNodeRef } from "@shared/node-ref";
import { getVellumApi } from "./vellum-api";

// Runtime-only browser meta cache. Canonical vellum:// refs are the durable
// identity; nodeId is display metadata and must never become a session key.
export const browser$ = observable({
  /** canonical vellum:// ref -> last known session info. */
  sessionByRef: {} as Record<string, BrowserSessionInfo>,
});

// getVellumApi() narrows its return type to VellumApi proper; every browser
// method lives on the sibling VellumBrowserApi slice that global.d.ts merges
// onto window.vellum at runtime. Cast per-call like herdr-state.ts already
// does for herdrGetMeta — Partial<> so a not-yet-landed method degrades to
// undefined rather than a type error.
type BrowserApi = ReturnType<typeof getVellumApi> & Partial<VellumBrowserApi>;

export const isCanonicalBrowserRef = (ref: string): boolean => parseNodeRef(ref).ok;

// Session ids are document-generation handles. Recent replaced handles stay in
// a bounded FIFO so late pushes cannot roll a ref backward; async responses are
// separately guarded by the handle observed when their request began.
const MAX_RETIRED_SESSION_IDS_PER_REF = 32;
const retiredSessionIdsByRef = new Map<string, ReadonlyArray<string>>();

export const isUsableBrowserSession = (
  session: BrowserSessionInfo | null | undefined,
): session is BrowserSessionInfo =>
  Boolean(
    session &&
      typeof session.ref === "string" &&
      isCanonicalBrowserRef(session.ref) &&
      typeof session.sessionId === "string" &&
      session.sessionId.trim().length > 0,
  );

export const browserSessionIdForRef = (ref: string): string | undefined => {
  const session = browser$.sessionByRef[ref].peek();
  return isUsableBrowserSession(session) && session.ref === ref ? session.sessionId : undefined;
};

const retireBrowserSessionId = (ref: string, sessionId: string): void => {
  const retired = retiredSessionIdsByRef.get(ref) ?? [];
  const next = [...retired.filter((candidate) => candidate !== sessionId), sessionId];
  retiredSessionIdsByRef.set(ref, next.slice(-MAX_RETIRED_SESSION_IDS_PER_REF));
};

/** Cache only sessions carrying both canonical identity and an opaque handle. */
export const cacheBrowserSession = (session: BrowserSessionInfo | null | undefined): boolean => {
  if (!isUsableBrowserSession(session)) return false;
  const currentSessionId = browserSessionIdForRef(session.ref);
  if (currentSessionId === session.sessionId) {
    browser$.sessionByRef[session.ref].set(session);
    return true;
  }
  if (retiredSessionIdsByRef.get(session.ref)?.includes(session.sessionId)) return false;
  if (currentSessionId) retireBrowserSessionId(session.ref, currentSessionId);
  browser$.sessionByRef[session.ref].set(session);
  return true;
};

/**
 * Cache an async response only if the ref has not advanced since the request
 * began. A response matching the already-current handle is still a safe state
 * refresh; any other response after an intervening generation is stale.
 */
export const cacheBrowserSessionIfUnchanged = (
  session: BrowserSessionInfo | null | undefined,
  observedSessionId: string | undefined,
): boolean => {
  if (!isUsableBrowserSession(session)) return false;
  const currentSessionId = browserSessionIdForRef(session.ref);
  if (currentSessionId !== observedSessionId && currentSessionId !== session.sessionId) {
    return false;
  }
  return cacheBrowserSession(session);
};

const clearBrowserSessionIfUnchanged = (
  ref: string,
  observedSessionId: string | undefined,
): boolean => {
  const currentSessionId = browserSessionIdForRef(ref);
  if (currentSessionId !== observedSessionId) return false;
  if (currentSessionId) retireBrowserSessionId(ref, currentSessionId);
  browser$.sessionByRef[ref].delete();
  // An authoritative absence ends this ref's local lineage. Pending async
  // reads remain protected by observedSessionId even after the bounded FIFO is
  // released, so removed refs do not accumulate renderer memory.
  retiredSessionIdsByRef.delete(ref);
  return true;
};

/** One-shot hydration for a card that mounts after the session already opened. */
export const refreshBrowserSession = async (ref: string): Promise<void> => {
  if (!isCanonicalBrowserRef(ref)) return;
  const api = getVellumApi() as BrowserApi | undefined;
  if (!api?.browserSessionList) return;
  const observedSessionId = browserSessionIdForRef(ref);
  try {
    const result = await api.browserSessionList();
    if (!result.ok || !result.data) return;
    const session = result.data.find(
      (candidate) => isUsableBrowserSession(candidate) && candidate.ref === ref,
    );
    if (session) {
      cacheBrowserSessionIfUnchanged(session, observedSessionId);
    } else {
      // list() is authoritative: never retain a handle that no longer exists.
      clearBrowserSessionIfUnchanged(ref, observedSessionId);
    }
  } catch {
    // Best-effort — the push subscription is the source of truth going forward.
  }
};

// Singleton fan-out: window.vellum.onBrowserSessionChanged -> sessionByRef,
// following the subscribeChatEvents precedent (chat-state.ts). Safe to call
// from every PageCard mount; only the first call actually subscribes. Absent
// the bridge method (IPC not landed yet) degrades to a no-op unsubscribe.
let activeUnsubscribe: (() => void) | undefined;

export const subscribeBrowserSessionEvents = (): (() => void) => {
  if (activeUnsubscribe) return activeUnsubscribe;
  const api = getVellumApi() as BrowserApi | undefined;
  if (!api?.onBrowserSessionChanged) return () => undefined;
  const unsubscribe = api.onBrowserSessionChanged((session) => {
    cacheBrowserSession(session);
  });
  activeUnsubscribe = () => {
    unsubscribe();
    activeUnsubscribe = undefined;
  };
  return activeUnsubscribe;
};

// Surface open/close moved to dock-state.ts — the WorkSurfaceDock owns the
// attach placeholder now; this module keeps only push-fed session state.
