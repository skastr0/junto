// Pure slot logic for the stage-level work-surface dock. No observables, no
// IPC, no DOM — dock-state.ts applies these transitions and performs the
// side effects (browserClose detach, herdr stream release) for evictions.

/**
 * "browser" slots host a native WebContentsView placeholder; "herdr" and
 * "chat" are interactive-stream surfaces. The dock never holds more than ONE
 * interactive surface at a time — that is the same single-control-stream
 * invariant herdr$ enforces via openHerdrTerminal/closeHerdrTerminal
 * (herdr-state.ts), restated at the slot level so a dock can never show two
 * terminals (or a terminal and a chat) competing for input.
 */
export type SurfaceKind = "browser" | "herdr" | "chat";

export interface DockSurface {
  readonly id: string;
  readonly kind: SurfaceKind;
}

export interface DockState {
  /** From BrowserProfileService config (maxVisibleSurfaces); default 2. */
  readonly maxVisible: number;
  /** Open slots, oldest first — index 0 is the first eviction candidate. */
  readonly surfaces: ReadonlyArray<DockSurface>;
}

export interface DockTransition {
  readonly state: DockState;
  /** Slots the caller must now detach (side effects live in dock-state.ts). */
  readonly evicted: ReadonlyArray<DockSurface>;
}

export const isInteractiveSurface = (kind: SurfaceKind): boolean => kind !== "browser";

export const initialDockState = (maxVisible = 2): DockState => ({
  maxVisible: clampMaxVisible(maxVisible),
  surfaces: [],
});

/** maxVisible below 1 would make the dock unable to hold anything — clamp. */
const clampMaxVisible = (n: number): number =>
  Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;

export const setMaxVisible = (state: DockState, maxVisible: number): DockTransition => {
  const next = clampMaxVisible(maxVisible);
  if (next === state.maxVisible && state.surfaces.length <= next) {
    return { state, evicted: [] };
  }
  // Shrinking below the open count evicts oldest-first, same as openSurface.
  const evicted = state.surfaces.slice(0, Math.max(0, state.surfaces.length - next));
  return {
    state: { maxVisible: next, surfaces: state.surfaces.slice(evicted.length) },
    evicted,
  };
};

/**
 * Request a slot. Re-requesting an already-open surface is a no-op (its slot
 * position is kept — reopening a page never reshuffles the dock). Otherwise:
 * 1. an existing interactive surface is evicted when the newcomer is also
 *    interactive (one interactive stream total), then
 * 2. oldest surfaces are evicted until the newcomer fits under maxVisible.
 */
export const openSurface = (state: DockState, surface: DockSurface): DockTransition => {
  const existing = state.surfaces.find((s) => s.id === surface.id);
  if (existing && existing.kind === surface.kind) return { state, evicted: [] };

  const evicted: DockSurface[] = [];
  let surfaces = state.surfaces;

  // Same id, different kind: the node changed roles — the stale slot goes.
  if (existing) {
    evicted.push(existing);
    surfaces = surfaces.filter((s) => s.id !== surface.id);
  }

  if (isInteractiveSurface(surface.kind)) {
    for (const s of surfaces) {
      if (isInteractiveSurface(s.kind)) evicted.push(s);
    }
    surfaces = surfaces.filter((s) => !isInteractiveSurface(s.kind));
  }

  while (surfaces.length >= state.maxVisible) {
    evicted.push(surfaces[0]!);
    surfaces = surfaces.slice(1);
  }

  return {
    state: { maxVisible: state.maxVisible, surfaces: [...surfaces, surface] },
    evicted,
  };
};

/** Close a slot. Closing an unknown id is a no-op (idempotent, never throws). */
export const closeSurface = (state: DockState, id: string): DockTransition => {
  const target = state.surfaces.find((s) => s.id === id);
  if (!target) return { state, evicted: [] };
  return {
    state: {
      maxVisible: state.maxVisible,
      surfaces: state.surfaces.filter((s) => s.id !== id),
    },
    evicted: [target],
  };
};

export const dockInteractiveSurface = (state: DockState): DockSurface | undefined =>
  state.surfaces.find((s) => isInteractiveSurface(s.kind));

export const dockBrowserSurfaces = (state: DockState): ReadonlyArray<DockSurface> =>
  state.surfaces.filter((s) => s.kind === "browser");
