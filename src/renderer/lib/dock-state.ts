import { observable } from "@legendapp/state";
import type { EtherBrowser } from "@shared/canvas";
import type { VellumBrowserApi } from "@shared/ipc";
import { browser$ } from "./browser-state";
import { closeHerdrTerminal, herdr$ } from "./herdr-state";
import {
  closeSurface,
  initialDockState,
  openSurface,
  setMaxVisible,
  type DockState,
  type DockSurface,
  type DockTransition,
} from "./surface-registry";
import { getVellumApi } from "./vellum-api";

// Stage-level work-surface dock: slot decisions are pure (surface-registry.ts);
// this module owns the observable + the side effects evictions demand. Every
// eviction/close DETACHES only — warm browser sessions and herdr panes survive
// (the product lock: nothing is wiped implicitly).

export interface DockBrowserPayload {
  readonly nodeId: string;
  readonly browser: EtherBrowser;
  readonly url: string;
  readonly title: string;
}

/** Reserved slot id for the (single) herdr terminal surface. */
export const HERDR_DOCK_ID = "herdr-terminal";

export const dock$ = observable({
  registry: initialDockState() as DockState,
  /** browser slot id (nodeId) -> attach payload for the dock's placeholder. */
  browserByNodeId: {} as Record<string, DockBrowserPayload>,
  configHydrated: false,
});

type BrowserApi = ReturnType<typeof getVellumApi> & Partial<VellumBrowserApi>;

const api = (): BrowserApi | undefined => getVellumApi() as BrowserApi | undefined;

/** One-shot maxVisibleSurfaces hydration from BrowserProfileService config. */
export const hydrateDockConfig = async (): Promise<void> => {
  if (dock$.configHydrated.peek()) return;
  dock$.configHydrated.set(true);
  const a = api();
  if (!a?.browserSurfaceConfig) return; // default 2 stands
  try {
    const result = await a.browserSurfaceConfig();
    const max = result.ok ? result.data?.maxVisibleSurfaces : undefined;
    if (typeof max === "number") applyTransition(setMaxVisible(dock$.registry.peek(), max));
  } catch {
    // Default 2 stands — never block the dock on a config read.
  }
};

/**
 * Run one registry transition and perform the detach side effects its
 * evictions demand. Browser evictions detach over IPC (session stays warm);
 * a herdr eviction releases the single control stream via closeHerdrTerminal
 * — the dock never leaves a second stream running behind an evicted slot.
 */
const applyTransition = (transition: DockTransition): void => {
  dock$.registry.set(transition.state);
  for (const evicted of transition.evicted) {
    if (evicted.kind === "browser") {
      dock$.browserByNodeId[evicted.id].delete();
      void api()?.browserClose?.(evicted.id).catch(() => undefined);
    } else {
      closeHerdrTerminal();
    }
  }
};

/**
 * Open (or re-focus) a page node's browser surface in the dock. The dock slot
 * appears immediately; the warm session opens/reuses over IPC and its state
 * flows back on the browserSessionChanged push channel.
 */
export const openDockBrowser = async (
  nodeId: string,
  browser: EtherBrowser,
  url: string,
  title: string,
): Promise<void> => {
  void hydrateDockConfig();
  dock$.browserByNodeId[nodeId].set({ nodeId, browser, url, title });
  applyTransition(openSurface(dock$.registry.peek(), { id: nodeId, kind: "browser" }));
  const a = api();
  if (!a?.browserOpen) return;
  try {
    const result = await a.browserOpen({ nodeId, url, profile: browser.profile });
    if (result.ok && result.data) browser$.sessionByNodeId[nodeId].set(result.data);
  } catch {
    // Session push events (or their absence) carry the failure state.
  }
};

/**
 * Detach a browser surface (UI first — never trap the operator behind a stuck
 * session). browserClose only detaches: the warm session and its cookies
 * survive, mirroring closeHerdrTerminal's detach-first shape.
 */
export const closeDockBrowser = (nodeId: string): void => {
  dock$.registry.set(closeSurface(dock$.registry.peek(), nodeId).state);
  dock$.browserByNodeId[nodeId].delete();
  // Always issue the IPC detach — a warm-but-undocked session (opened earlier,
  // evicted from the dock) must still detach from the card's own action.
  void api()?.browserClose?.(nodeId).catch(() => undefined);
};

/**
 * Keep the dock's herdr slot in sync with herdr$.terminal (the single source
 * of the one-control-stream invariant — this module never opens a second).
 * The terminal only docks while a browser surface is open; alone it stays in
 * the full-window HerdrTerminalModal, which remains the plain-canvas surface.
 */
export const syncDockHerdrSlot = (): void => {
  const registry = dock$.registry.peek();
  const terminal = herdr$.terminal.peek();
  const hasBrowser = registry.surfaces.some((s) => s.kind === "browser");
  const herdrSlot = registry.surfaces.find((s) => s.kind === "herdr");

  if (terminal && hasBrowser) {
    if (!herdrSlot) {
      // Slot bookkeeping only: evicted browsers detach, but a herdr "eviction"
      // here would close the very terminal we are docking — filter it out.
      const transition = openSurface(registry, { id: HERDR_DOCK_ID, kind: "herdr" });
      applyTransition({
        state: transition.state,
        evicted: transition.evicted.filter((s) => s.kind === "browser"),
      });
    }
  } else if (herdrSlot) {
    // Terminal closed, or last browser left (modal takes over) — drop the
    // slot without touching the stream.
    dock$.registry.set(closeSurface(registry, herdrSlot.id).state);
  }
};

export const dockSurfaces = (): ReadonlyArray<DockSurface> => dock$.registry.peek().surfaces;
