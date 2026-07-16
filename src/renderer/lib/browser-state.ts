import { observable } from "@legendapp/state";
import type { EtherBrowser } from "@shared/canvas";
import type { BrowserSessionInfo, VellumBrowserApi } from "@shared/ipc";
import { getVellumApi } from "./vellum-api";

// Runtime-only browser meta cache — mirrors herdr$.metaByNodeId (herdr-state.ts)
// but is PUSH-fed (onBrowserSessionChanged) rather than polled: the main
// process already owns the session's live state and broadcasts every change.
export const browser$ = observable({
  /** nodeId -> currently portaled attach surface, at most one at a time. */
  surface: null as BrowserSurfaceOpen | null,
  /** nodeId -> last known session info. */
  sessionByNodeId: {} as Record<string, BrowserSessionInfo>,
});

export interface BrowserSurfaceOpen {
  readonly nodeId: string;
  readonly browser: EtherBrowser;
  readonly url: string;
  readonly title: string;
}

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

/**
 * Request the surface attach. Opens/reuses the warm session over IPC, then
 * marks the portal container as wanting a surface — BrowserSurfaceModal reads
 * `surface` and drives browserSetBounds once it has a real rect. Honest
 * degrade: an IPC failure surfaces on the session's `failed` state via the
 * push channel, never a thrown error here.
 */
export const openBrowserSurface = async (
  nodeId: string,
  browser: EtherBrowser,
  url: string,
  title: string,
): Promise<void> => {
  browser$.surface.set({ nodeId, browser, url, title });
  const api = getVellumApi() as BrowserApi | undefined;
  if (!api?.browserOpen) return;
  try {
    const result = await api.browserOpen({ nodeId, url, profile: browser.profile });
    if (result.ok && result.data) browser$.sessionByNodeId[nodeId].set(result.data);
  } catch {
    // Session push events (or their absence) carry the failure state.
  }
};

/**
 * Detach a session's surface (UI first — never trap the operator behind a
 * stuck session). browserClose only detaches: the warm session and its
 * cookies survive, mirroring closeHerdrTerminal's detach-first shape.
 *
 * `nodeId` defaults to whichever node's surface is currently portaled — the
 * modal's own Close button/Escape call this with no argument. PageCard's own
 * "detach" action passes its node.id explicitly so it always targets ITS
 * session (never whatever the modal happens to show), and only clears the
 * portal state when it was the one open.
 */
export const closeBrowserSurface = (nodeId?: string): void => {
  const surface = browser$.surface.peek();
  const target = nodeId ?? surface?.nodeId;
  if (!target) return;
  if (surface?.nodeId === target) browser$.surface.set(null);
  const api = getVellumApi() as BrowserApi | undefined;
  void api?.browserClose?.(target).catch(() => undefined);
};
