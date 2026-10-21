// Pure workbench slot logic. No observables, no IPC, no DOM — dock-state.ts
// applies these transitions and performs side effects (browser detach,
// stream release) for closed/evicted interactive surfaces.
//
// Product model:
// - One focus view (centered modal) holds every open surface.
// - Layout: solo | split-v | split-h (1 or 2 visible panes).
// - Surplus surfaces become tabs via an MRU stack (front = active).
// - No hard maxVisible UI eviction — tabs replace detach-on-overflow.
//   Per-terminal control exclusivity is host-side; not a global UI lock.

export type SurfaceKind =
  | "browser"
  | "terminal"
  | "task-create"
  | "note";
export type LayoutMode = "solo" | "split-v" | "split-h";

export interface WorkSurface {
  readonly id: string;
  readonly kind: SurfaceKind;
}

/**
 * Which focus-shell layout a remembered width applies to.
 * Must match WorkFocusShell's measure derivation so a narrow terminal resize
 * never poisons task-create / workspace width (or the reverse).
 */
export type WorkFocusSizeKey =
  | "terminal"
  | "workspace"
  | "task-create"
  | "document";

export type WorkFocusSize = {
  readonly key: WorkFocusSizeKey;
  readonly width: number;
  readonly height: number;
};

export interface WorkbenchState {
  readonly surfaces: ReadonlyArray<WorkSurface>;
  /** Most recent first; index 0 is frontmost. */
  readonly focusMru: ReadonlyArray<string>;
  readonly focusLayout: LayoutMode;
  /**
   * Last user-resized focus panel box, keyed by shell layout family.
   * Null / missing key → CSS measure owns width (no inline override).
   */
  readonly focusSize: WorkFocusSize | null;
}

export interface WorkbenchTransition {
  readonly state: WorkbenchState;
  /** Surfaces the caller must fully close (stream release / browser detach). */
  readonly evicted: ReadonlyArray<WorkSurface>;
}

export interface VisiblePanes {
  readonly pane0: string | undefined;
  readonly pane1: string | undefined;
  readonly tabs: ReadonlyArray<string>;
}

export const isInteractiveSurface = (kind: SurfaceKind): boolean => kind !== "browser";

export const panesForLayout = (layout: LayoutMode): 1 | 2 => (layout === "solo" ? 1 : 2);

export const initialWorkbenchState = (): WorkbenchState => ({
  surfaces: [],
  focusMru: [],
  focusLayout: "solo",
  focusSize: null,
});

const withoutId = (ids: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
  ids.filter((x) => x !== id);

/** Prepend id to MRU (front = most recent). */
const prependMru = (ids: ReadonlyArray<string>, id: string): ReadonlyArray<string> => [
  id,
  ...withoutId(ids, id),
];

export const surfaceById = (
  state: WorkbenchState,
  id: string,
): WorkSurface | undefined => state.surfaces.find((s) => s.id === id);

export const visiblePanes = (state: WorkbenchState): VisiblePanes => {
  const mru = state.focusMru;
  const paneCount = panesForLayout(state.focusLayout);
  if (mru.length === 0) return { pane0: undefined, pane1: undefined, tabs: [] };
  if (paneCount === 1) {
    return { pane0: mru[0], pane1: undefined, tabs: mru.slice(1) };
  }
  return {
    pane0: mru[0],
    pane1: mru[1],
    tabs: mru.slice(2),
  };
};

/**
 * Open (or re-focus) a surface in the focus view. A surface that is already
 * open, whatever its kind, comes to the front.
 * Multiple browser surfaces coexist — no global interactive eviction.
 */
export const openSurface = (
  state: WorkbenchState,
  surface: { readonly id: string; readonly kind: SurfaceKind },
): WorkbenchTransition => {
  const existing = surfaceById(state, surface.id);
  if (existing && existing.kind === surface.kind) {
    return {
      state: { ...state, focusMru: prependMru(state.focusMru, existing.id) },
      evicted: [],
    };
  }

  const evicted: WorkSurface[] = [];
  let surfaces = state.surfaces;

  // Same id, different kind: replace stale slot.
  if (existing) {
    evicted.push(existing);
    surfaces = surfaces.filter((s) => s.id !== surface.id);
  }

  const next: WorkSurface = { id: surface.id, kind: surface.kind };
  return {
    state: {
      ...state,
      surfaces: [...surfaces, next],
      focusMru: prependMru(state.focusMru, next.id),
    },
    evicted,
  };
};

export const closeSurface = (state: WorkbenchState, id: string): WorkbenchTransition => {
  const target = surfaceById(state, id);
  if (!target) return { state, evicted: [] };
  return {
    state: {
      ...state,
      surfaces: state.surfaces.filter((s) => s.id !== id),
      focusMru: withoutId(state.focusMru, id),
    },
    evicted: [target],
  };
};

/** Bring a surface to the front of the MRU. No-op if unknown. */
export const focusSurface = (state: WorkbenchState, id: string): WorkbenchTransition => {
  if (!surfaceById(state, id)) return { state, evicted: [] };
  if (state.focusMru[0] === id) return { state, evicted: [] };
  return {
    state: { ...state, focusMru: prependMru(state.focusMru, id) },
    evicted: [],
  };
};

export const setLayout = (
  state: WorkbenchState,
  layout: LayoutMode,
): WorkbenchTransition => {
  if (state.focusLayout === layout) return { state, evicted: [] };
  return { state: { ...state, focusLayout: layout }, evicted: [] };
};

export const setFocusSize = (
  state: WorkbenchState,
  size: WorkFocusSize | null,
): WorkbenchTransition => {
  if (size === null && state.focusSize === null) {
    return { state, evicted: [] };
  }
  if (
    size &&
    state.focusSize &&
    size.key === state.focusSize.key &&
    size.width === state.focusSize.width &&
    size.height === state.focusSize.height
  ) {
    return { state, evicted: [] };
  }
  return { state: { ...state, focusSize: size }, evicted: [] };
};

/** Resolve focus-shell size key from the open surfaces. */
export const workFocusSizeKeyForSurfaces = (
  focusSurfaces: ReadonlyArray<WorkSurface>,
): WorkFocusSizeKey => {
  if (focusSurfaces.length === 0) return "workspace";
  if (focusSurfaces.every((s) => s.kind === "terminal")) {
    return "terminal";
  }
  if (focusSurfaces.every((s) => s.kind === "task-create")) return "task-create";
  if (focusSurfaces.every((s) => s.kind === "note")) return "document";
  return "workspace";
};

/**
 * Whether the focus view renders its chrome (tab / split strip).
 * Single source for close semantics: without this chrome, stacked surfaces
 * are invisible — the view presents as ONE modal, and Close must dismiss it
 * whole rather than pop the hidden MRU one press at a time.
 */
export const focusChromeVisible = (state: WorkbenchState): boolean =>
  state.surfaces.length > 1 && workFocusSizeKeyForSurfaces(state.surfaces) !== "terminal";

export const workbenchInteractiveSurface = (
  state: WorkbenchState,
): WorkSurface | undefined => state.surfaces.find((s) => isInteractiveSurface(s.kind));

export const workbenchBrowserSurfaces = (
  state: WorkbenchState,
): ReadonlyArray<WorkSurface> => state.surfaces.filter((s) => s.kind === "browser");
