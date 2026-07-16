import { observable } from "@legendapp/state";
import type { BrowserSessionInfo, VellumBrowserApi } from "@shared/ipc";
import { getVellumApi } from "./vellum-api";

// Runtime-only browser meta cache — mirrors herdr$.metaByNodeId (herdr-state.ts)
// but is PUSH-fed (onBrowserSessionChanged) rather than polled: the main
// process already owns the session's live state and broadcasts every change.
export const browser$ = observable({
  /** nodeId -> last known session info. */
  sessionByNodeId: {} as Record<string, BrowserSessionInfo>,
});

// getVellumApi() narrows its return type to VellumApi proper; every browser
// method lives on the sibling VellumBrowserApi slice that global.d.ts merges
// onto window.vellum at runtime. Cast per-call like herdr-state.ts already
// does for herdrGetMeta — Partial<> so a not-yet-landed method degrades to
// undefined rather than a type error.
type BrowserApi = ReturnType<typeof getVellumApi> & Partial<VellumBrowserApi>;

/** One-shot hydration for a card that mounts after the session already opened. */
export const refreshBrowserSession = async (nodeId: string): Promise<void> => {
  const api = getVellumApi() as BrowserApi | undefined;
  if (!api?.browserSessionState) return;
  try {
    const result = await api.browserSessionState(nodeId);
    if (result.ok && result.data) browser$.sessionByNodeId[nodeId].set(result.data);
  } catch {
    // Best-effort — the push subscription is the source of truth going forward.
  }
};

// Singleton fan-out: window.vellum.onBrowserSessionChanged -> sessionByNodeId,
// following the subscribeChatEvents precedent (chat-state.ts). Safe to call
// from every PageCard mount; only the first call actually subscribes. Absent
// the bridge method (IPC not landed yet) degrades to a no-op unsubscribe.
let activeUnsubscribe: (() => void) | undefined;

export const subscribeBrowserSessionEvents = (): (() => void) => {
  if (activeUnsubscribe) return activeUnsubscribe;
  const api = getVellumApi() as BrowserApi | undefined;
  if (!api?.onBrowserSessionChanged) return () => undefined;
  const unsubscribe = api.onBrowserSessionChanged((session) => {
    if (!session?.nodeId) return;
    browser$.sessionByNodeId[session.nodeId].set(session);
  });
  activeUnsubscribe = () => {
    unsubscribe();
    activeUnsubscribe = undefined;
  };
  return activeUnsubscribe;
};

// Surface open/close moved to dock-state.ts — the WorkSurfaceDock owns the
// attach placeholder now; this module keeps only push-fed session state.
