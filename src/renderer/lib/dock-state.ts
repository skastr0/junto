import { observable, observe } from "@legendapp/state";
import type { EtherBrowser } from "@shared/canvas";
import type { VellumBrowserApi } from "@shared/ipc";
import {
  browser$,
  browserSessionIdForRef,
  cacheBrowserSessionIfUnchanged,
  clearBrowserSessionIfUnchanged,
  isCanonicalBrowserRef,
  isUsableBrowserSession,
} from "./browser-state";
import {
  clearHerdrKeyboardFocus,
  closeHerdrTerminal,
  focusHerdrTerminal,
  herdr$,
  herdrTerminalIds,
} from "./herdr-state";
import {
  closeSurface,
  focusSurface,
  initialWorkbenchState,
  openSurface,
  pinSurface,
  setFocusSize,
  setLayout,
  setPinnedWidthFrac,
  surfaceById,
  unpinSurface,
  type LayoutMode,
  type WorkbenchState,
  type WorkbenchTransition,
  type WorkSurface,
  type WorkZone,
} from "./surface-registry";
import { getVellumApi } from "./vellum-api";

// Workbench side effects: pure transitions live in surface-registry.ts; this
// module owns the observable + detach/stream cleanup. Every close DETACHES
// only — warm browser sessions and herdr panes survive unless Stop Page or
// herdr kill is explicit.

export interface DockBrowserPayload {
  readonly nodeId: string;
  readonly browser: EtherBrowser;
  readonly url: string;
  readonly title: string;
}

const HERDR_SURFACE_PREFIX = "herdr:";

/** Surface id for a herdr terminal bound to a canvas node. */
export const herdrSurfaceId = (nodeId: string): string => `${HERDR_SURFACE_PREFIX}${nodeId}`;

/** Inverse of herdrSurfaceId — null when the id is not a herdr surface. */
export const parseHerdrSurfaceId = (id: string): string | null => {
  if (!id.startsWith(HERDR_SURFACE_PREFIX)) return null;
  const nodeId = id.slice(HERDR_SURFACE_PREFIX.length);
  return nodeId.length > 0 ? nodeId : null;
};

/** @deprecated Prefer herdrSurfaceId(nodeId) — global id no longer used. */
export const HERDR_DOCK_ID = "herdr-terminal";

export const dock$ = observable({
  registry: initialWorkbenchState() as WorkbenchState,
  /** canonical vellum:// ref -> display payload for browser slots. */
  browserByRef: {} as Record<string, DockBrowserPayload>,
  /** Explicit Stop Page failures stay visible until retry/open succeeds. */
  stopErrorByRef: {} as Record<string, string>,
  configHydrated: false,
});

type BrowserApi = ReturnType<typeof getVellumApi> & Partial<VellumBrowserApi>;

const api = (): BrowserApi | undefined => getVellumApi() as BrowserApi | undefined;

const detachCurrentSession = (ref: string): void => {
  const sessionId = browserSessionIdForRef(ref);
  if (!sessionId) return;
  void api()?.browserClose?.(sessionId).catch(() => undefined);
};

const clearStoppedSurface = (ref: string, observedSessionId: string | undefined): boolean => {
  if (!clearBrowserSessionIfUnchanged(ref, observedSessionId)) return false;
  dock$.registry.set(closeSurface(dock$.registry.peek(), ref).state);
  dock$.browserByRef[ref].delete();
  return true;
};

/**
 * One-shot hydrate marker. maxVisibleSurfaces is not a UI admission cap
 * (tabs + keep-alive); warm session limits still live in main.
 */
export const hydrateDockConfig = async (): Promise<void> => {
  if (dock$.configHydrated.peek()) return;
  dock$.configHydrated.set(true);
  void api()?.browserSurfaceConfig?.().catch(() => undefined);
};

/**
 * Apply one registry transition and run side effects for fully-closed surfaces.
 * Browser closes detach over IPC (session stays warm); herdr closes release
 * that nodeId's control stream only.
 */
const applyTransition = (transition: WorkbenchTransition): void => {
  dock$.registry.set(transition.state);
  for (const closed of transition.evicted) {
    if (closed.kind === "browser") {
      dock$.browserByRef[closed.id].delete();
      detachCurrentSession(closed.id);
    } else if (closed.kind === "herdr") {
      // Only release stream if the herdr surface itself was closed/evicted —
      // not when merely moving zones (pin/unpin never emit herdr in evicted).
      const nodeId = parseHerdrSurfaceId(closed.id);
      if (nodeId) closeHerdrTerminal(nodeId);
    }
  }
};

/**
 * Reconcile the workbench with main-process live sessions after renderer reload.
 * Attached sessions land in the focus zone (v1 — no zone persistence yet).
 */
let reconciledLiveSessions = false;

export const reconcileDockFromLiveSessions = async (): Promise<void> => {
  if (reconciledLiveSessions) return;
  reconciledLiveSessions = true;
  const a = api();
  if (!a?.browserSessionList) return;
  const observedSessionIds = new Map(
    Object.entries(browser$.sessionByRef.peek()).flatMap(([ref, session]) => {
      const sessionId = isUsableBrowserSession(session) ? session.sessionId : undefined;
      return sessionId ? [[ref, sessionId] as const] : [];
    }),
  );
  try {
    const result = await a.browserSessionList();
    if (!result.ok || !result.data) return;
    for (const session of result.data) {
      if (!session.attached || !isUsableBrowserSession(session)) continue;
      if (!cacheBrowserSessionIfUnchanged(session, observedSessionIds.get(session.ref))) continue;
      dock$.browserByRef[session.ref].set({
        nodeId: session.nodeId,
        browser: { profile: session.profile },
        url: session.url,
        title: session.title ?? session.url,
      });
      applyTransition(
        openSurface(dock$.registry.peek(), { id: session.ref, kind: "browser" }, "focus"),
      );
    }
  } catch {
    // Best-effort — unreconciled attached session degrades to manual recovery.
  }
};

/**
 * Open (or re-focus) a page browser surface in the **focus** zone by default.
 * Slot appears immediately; warm session opens/reuses over IPC.
 */
export const openDockBrowser = async (
  ref: string,
  payload: DockBrowserPayload,
  zone: WorkZone = "focus",
): Promise<void> => {
  if (!isCanonicalBrowserRef(ref)) return;
  dock$.stopErrorByRef[ref].delete();
  await hydrateDockConfig();
  dock$.browserByRef[ref].set(payload);
  applyTransition(openSurface(dock$.registry.peek(), { id: ref, kind: "browser" }, zone));
  const a = api();
  if (!a?.browserOpen) return;
  const observedSessionId = browserSessionIdForRef(ref);
  try {
    const result = await a.browserOpen({ ref });
    if (result.ok && result.data?.ref === ref) {
      cacheBrowserSessionIfUnchanged(result.data, observedSessionId);
    }
  } catch {
    // Session push events (or their absence) carry the failure state.
  }
};

/** Detach a browser surface (UI first). Session and cookies survive. */
export const closeDockBrowser = (ref: string): void => {
  applyTransition(closeSurface(dock$.registry.peek(), ref));
};

/**
 * Reconcile workbench herdr surfaces with herdr$.terminals:
 * - every open terminal gets a focus-zone surface (id = herdrSurfaceId(nodeId))
 * - focused terminal is promoted to zone MRU front
 * - surfaces for closed terminals are dropped without a second stream release
 * Pin moves a slot without reopening the stream.
 */
export const syncHerdrWorkbenchSlot = (): void => {
  const openIds = new Set(herdrTerminalIds());
  const focused = herdr$.focusedNodeId.peek();
  let registry = dock$.registry.peek();

  // Drop slots whose terminal is gone (stream already released by closeHerdrTerminal).
  for (const surface of registry.surfaces) {
    if (surface.kind !== "herdr") continue;
    const nodeId = parseHerdrSurfaceId(surface.id);
    if (nodeId && openIds.has(nodeId)) continue;
    registry = closeSurface(registry, surface.id).state;
  }
  dock$.registry.set(registry);

  // Ensure a focus-zone surface for every open terminal; re-open promotes MRU.
  for (const nodeId of openIds) {
    const id = herdrSurfaceId(nodeId);
    if (surfaceById(registry, id)) {
      // Already registered — if keyboard-focused, bring to front of its zone.
      if (focused === nodeId) {
        applyTransition(focusSurface(registry, id));
        registry = dock$.registry.peek();
      }
      continue;
    }
    const transition = openSurface(registry, { id, kind: "herdr" }, "focus");
    // Never re-release herdr streams while registering (evicted herdrs filtered).
    applyTransition({
      state: transition.state,
      evicted: transition.evicted.filter((s) => s.kind !== "herdr"),
    });
    registry = dock$.registry.peek();
  }
};

/** @deprecated Use syncHerdrWorkbenchSlot — no longer auto-docks when browser opens. */
export const syncDockHerdrSlot = syncHerdrWorkbenchSlot;

// Synchronous bridge: herdr open/close updates registry before React paints
// (no dynamic-import flash of orphan modal → shell).
observe(() => {
  // Track full terminals map + focus for MRU promote.
  herdr$.terminals.get();
  herdr$.focusedNodeId.get();
  syncHerdrWorkbenchSlot();
});

export const pinWorkbenchSurface = (id: string): void => {
  applyTransition(pinSurface(dock$.registry.peek(), id));
};

export const unpinWorkbenchSurface = (id: string): void => {
  applyTransition(unpinSurface(dock$.registry.peek(), id));
};

export const focusWorkbenchSurface = (id: string): void => {
  applyTransition(focusSurface(dock$.registry.peek(), id));
};

/**
 * Promote surface to zone MRU front and route keyboard:
 * herdr → focusHerdrTerminal; anything else → clear herdr keyboard capture.
 */
export const activateWorkbenchSurface = (id: string): void => {
  applyTransition(focusSurface(dock$.registry.peek(), id));
  const surface = surfaceById(dock$.registry.peek(), id);
  if (!surface) return;
  if (surface.kind === "herdr") {
    const nodeId = parseHerdrSurfaceId(id);
    if (nodeId) focusHerdrTerminal(nodeId);
    return;
  }
  clearHerdrKeyboardFocus();
};

export const setWorkbenchLayout = (zone: WorkZone, layout: LayoutMode): void => {
  applyTransition(setLayout(dock$.registry.peek(), zone, layout));
};

export const setWorkbenchPinnedWidthFrac = (frac: number): void => {
  applyTransition(setPinnedWidthFrac(dock$.registry.peek(), frac));
};

export const setWorkbenchFocusSize = (
  size: { readonly width: number; readonly height: number } | null,
): void => {
  applyTransition(setFocusSize(dock$.registry.peek(), size));
};

export const closeWorkbenchSurface = (id: string): void => {
  const surface = dock$.registry.peek().surfaces.find((s) => s.id === id);
  if (!surface) return;
  if (surface.kind === "browser") {
    closeDockBrowser(id);
    return;
  }
  // herdr: closeSurface + applyTransition releases that nodeId's stream and
  // drops the slot immediately (no async lag).
  applyTransition(closeSurface(dock$.registry.peek(), id));
};

/**
 * Explicitly stop one page runtime by exact opaque handle. Surface remains
 * visible on failure; removed only after authoritative destruction.
 */
export const stopDockBrowser = async (ref: string): Promise<boolean> => {
  dock$.stopErrorByRef[ref].delete();
  const a = api();
  if (!a?.browserStop) {
    dock$.stopErrorByRef[ref].set("Stop Page is unavailable.");
    return false;
  }
  let sessionId = browserSessionIdForRef(ref);
  if (!sessionId) {
    if (!a.browserSessionList) {
      dock$.stopErrorByRef[ref].set("Could not verify whether this page is still running.");
      return false;
    }
    try {
      const listed = await a.browserSessionList();
      if (!listed.ok || !listed.data) {
        dock$.stopErrorByRef[ref].set(listed.message ?? "Could not verify whether this page is still running.");
        return false;
      }
      const live = listed.data.find(
        (candidate) => isUsableBrowserSession(candidate) && candidate.ref === ref,
      );
      sessionId = live?.sessionId;
      if (live) cacheBrowserSessionIfUnchanged(live, undefined);
      if (!sessionId) {
        if (clearStoppedSurface(ref, undefined)) return true;
        dock$.stopErrorByRef[ref].set("Page runtime changed while stopping; retry Stop Page.");
        return false;
      }
    } catch {
      dock$.stopErrorByRef[ref].set("Could not verify whether this page is still running.");
      return false;
    }
  }
  try {
    const result = await a.browserStop(sessionId);
    if (result.ok) {
      if (clearStoppedSurface(ref, sessionId)) return true;
      dock$.stopErrorByRef[ref].set("Page runtime changed while stopping; retry Stop Page.");
      return false;
    }
    if (result.code === "not_found" && a.browserSessionList) {
      const listed = await a.browserSessionList();
      if (listed.ok && listed.data) {
        const live = listed.data.find(
          (candidate) => isUsableBrowserSession(candidate) && candidate.ref === ref,
        );
        if (!live) {
          if (clearStoppedSurface(ref, sessionId)) return true;
          dock$.stopErrorByRef[ref].set("Page runtime changed while stopping; retry Stop Page.");
          return false;
        }
        if (live.sessionId !== sessionId) {
          cacheBrowserSessionIfUnchanged(live, sessionId);
          dock$.stopErrorByRef[ref].set("Page runtime changed while stopping; retry Stop Page.");
          return false;
        }
      }
    }
    dock$.stopErrorByRef[ref].set(result.message ?? "Stop Page failed.");
  } catch {
    dock$.stopErrorByRef[ref].set("Stop Page failed.");
  }
  return false;
};

export const dockSurfaces = (): ReadonlyArray<WorkSurface> => dock$.registry.peek().surfaces;
