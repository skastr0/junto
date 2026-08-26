// Pure workbench slot logic. No observables, no IPC, no DOM — dock-state.ts
// applies these transitions and performs side effects (browser detach,
// stream release) for closed/evicted interactive surfaces.
//
// Product model:
// - Two zones: focus (centered modal, default for new opens) and pinned
//   (stage-right dock, explicit pin only).
// - Per-zone layout: solo | split-v | split-h (1 or 2 visible panes).
// - Surplus surfaces become tabs via an MRU stack (front = active).
// - No hard maxVisible UI eviction — tabs replace detach-on-overflow.
//   Per-terminal control exclusivity is host-side; not a global UI lock.

export type SurfaceKind =
  | "browser"
  | "terminal"
  | "chat"
  | "task-create"
  | "note";
export type WorkZone = "focus" | "pinned";
export type LayoutMode = "solo" | "split-v" | "split-h";

export interface WorkSurface {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly zone: WorkZone;
}

/**
 * Which focus-shell layout a remembered width applies to.
 * Must match WorkFocusShell's measure derivation so a narrow terminal resize
 * never poisons task-create / chat / workspace width (or the reverse).
 */
export type WorkFocusSizeKey =
  | "terminal"
  | "workspace"
  | "chat"
  | "task-create"
  | "document";

export type WorkFocusSize = {
  readonly key: WorkFocusSizeKey;
  readonly width: number;
  readonly height: number;
};

export interface WorkbenchState {
  readonly surfaces: ReadonlyArray<WorkSurface>;
  /** MRU per zone; index 0 is frontmost. */
  readonly focusMru: ReadonlyArray<string>;
  readonly pinnedMru: ReadonlyArray<string>;
  readonly focusLayout: LayoutMode;
  readonly pinnedLayout: LayoutMode;
  /**
   * Last user-resized focus panel box, keyed by shell layout family.
   * Null / missing key → CSS measure owns width (no inline override).
   */
  readonly focusSize: WorkFocusSize | null;
  /** Fraction of stage width for the pinned dock (0.25–0.70). */
  readonly pinnedWidthFrac: number;
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

const DEFAULT_PINNED_WIDTH_FRAC = 0.45;
const MIN_PINNED_WIDTH_FRAC = 0.25;
const MAX_PINNED_WIDTH_FRAC = 0.7;

export const clampPinnedWidthFrac = (n: number): number => {
  if (!Number.isFinite(n)) return DEFAULT_PINNED_WIDTH_FRAC;
  return Math.min(MAX_PINNED_WIDTH_FRAC, Math.max(MIN_PINNED_WIDTH_FRAC, n));
};

export const initialWorkbenchState = (): WorkbenchState => ({
  surfaces: [],
  focusMru: [],
  pinnedMru: [],
  focusLayout: "solo",
  pinnedLayout: "solo",
  focusSize: null,
  pinnedWidthFrac: DEFAULT_PINNED_WIDTH_FRAC,
});

const mruKey = (zone: WorkZone): "focusMru" | "pinnedMru" =>
  zone === "focus" ? "focusMru" : "pinnedMru";

const layoutKey = (zone: WorkZone): "focusLayout" | "pinnedLayout" =>
  zone === "focus" ? "focusLayout" : "pinnedLayout";

const withoutId = (ids: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
  ids.filter((x) => x !== id);

/** Prepend id to MRU (front = most recent). */
const prependMru = (ids: ReadonlyArray<string>, id: string): ReadonlyArray<string> => [
  id,
  ...withoutId(ids, id),
];

const zoneSurfaces = (state: WorkbenchState, zone: WorkZone): ReadonlyArray<WorkSurface> =>
  state.surfaces.filter((s) => s.zone === zone);

export const surfaceById = (
  state: WorkbenchState,
  id: string,
): WorkSurface | undefined => state.surfaces.find((s) => s.id === id);

export const visiblePanes = (state: WorkbenchState, zone: WorkZone): VisiblePanes => {
  const mru = state[mruKey(zone)];
  const layout = state[layoutKey(zone)];
  const paneCount = panesForLayout(layout);
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
 * Open (or re-focus) a surface into a zone. Default zone is focus.
 * Re-requesting an already-open surface moves it to the front of its current
 * zone MRU (zone argument ignored when already open, unless kinds clash).
 * Multiple browser surfaces coexist — no global interactive eviction.
 */
export const openSurface = (
  state: WorkbenchState,
  surface: { readonly id: string; readonly kind: SurfaceKind },
  zone: WorkZone = "focus",
): WorkbenchTransition => {
  const existing = surfaceById(state, surface.id);
  if (existing && existing.kind === surface.kind) {
    // Re-focus: bring to front of its current zone.
    const z = existing.zone;
    return {
      state: {
        ...state,
        [mruKey(z)]: prependMru(state[mruKey(z)], existing.id),
      },
      evicted: [],
    };
  }

  const evicted: WorkSurface[] = [];
  let surfaces = state.surfaces;
  let focusMru = state.focusMru;
  let pinnedMru = state.pinnedMru;

  // Same id, different kind: replace stale slot.
  if (existing) {
    evicted.push(existing);
    surfaces = surfaces.filter((s) => s.id !== surface.id);
    focusMru = withoutId(focusMru, surface.id);
    pinnedMru = withoutId(pinnedMru, surface.id);
  }

  const next: WorkSurface = { id: surface.id, kind: surface.kind, zone };
  surfaces = [...surfaces, next];
  if (zone === "focus") {
    focusMru = prependMru(focusMru, next.id);
  } else {
    pinnedMru = prependMru(pinnedMru, next.id);
  }

  return {
    state: { ...state, surfaces, focusMru, pinnedMru },
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
      pinnedMru: withoutId(state.pinnedMru, id),
    },
    evicted: [target],
  };
};

/** Bring a surface to the front of its zone MRU. No-op if unknown. */
export const focusSurface = (state: WorkbenchState, id: string): WorkbenchTransition => {
  const target = surfaceById(state, id);
  if (!target) return { state, evicted: [] };
  const key = mruKey(target.zone);
  if (state[key][0] === id) return { state, evicted: [] };
  return {
    state: { ...state, [key]: prependMru(state[key], id) },
    evicted: [],
  };
};

export const pinSurface = (state: WorkbenchState, id: string): WorkbenchTransition => {
  const target = surfaceById(state, id);
  if (!target || target.zone === "pinned") return { state, evicted: [] };
  return {
    state: {
      ...state,
      surfaces: state.surfaces.map((s) =>
        s.id === id ? { ...s, zone: "pinned" as const } : s,
      ),
      focusMru: withoutId(state.focusMru, id),
      pinnedMru: prependMru(state.pinnedMru, id),
    },
    evicted: [],
  };
};

export const unpinSurface = (state: WorkbenchState, id: string): WorkbenchTransition => {
  const target = surfaceById(state, id);
  if (!target || target.zone === "focus") return { state, evicted: [] };
  return {
    state: {
      ...state,
      surfaces: state.surfaces.map((s) =>
        s.id === id ? { ...s, zone: "focus" as const } : s,
      ),
      pinnedMru: withoutId(state.pinnedMru, id),
      focusMru: prependMru(state.focusMru, id),
    },
    evicted: [],
  };
};

export const setLayout = (
  state: WorkbenchState,
  zone: WorkZone,
  layout: LayoutMode,
): WorkbenchTransition => {
  const key = layoutKey(zone);
  if (state[key] === layout) return { state, evicted: [] };
  return { state: { ...state, [key]: layout }, evicted: [] };
};

export const setPinnedWidthFrac = (
  state: WorkbenchState,
  frac: number,
): WorkbenchTransition => {
  const next = clampPinnedWidthFrac(frac);
  if (next === state.pinnedWidthFrac) return { state, evicted: [] };
  return { state: { ...state, pinnedWidthFrac: next }, evicted: [] };
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

/** Resolve focus-shell size key from the surfaces currently in the focus zone. */
export const workFocusSizeKeyForSurfaces = (
  focusSurfaces: ReadonlyArray<WorkSurface>,
): WorkFocusSizeKey => {
  if (focusSurfaces.length === 0) return "workspace";
  if (focusSurfaces.every((s) => s.kind === "terminal")) {
    return "terminal";
  }
  if (focusSurfaces.every((s) => s.kind === "chat")) return "chat";
  if (focusSurfaces.every((s) => s.kind === "task-create")) return "task-create";
  if (focusSurfaces.every((s) => s.kind === "note")) return "document";
  return "workspace";
};

/**
 * Whether the focus zone renders the dock chrome (tab / split strip).
 * Single source for close semantics: without this chrome, stacked focus
 * surfaces are invisible — the zone presents as ONE modal, and Close must
 * dismiss it whole rather than pop the hidden MRU one press at a time.
 */
export const focusDockChromeVisible = (state: WorkbenchState): boolean => {
  const focus = state.surfaces.filter((s) => s.zone === "focus");
  return focus.length > 1 && workFocusSizeKeyForSurfaces(focus) !== "terminal";
};

export const workbenchInteractiveSurface = (
  state: WorkbenchState,
): WorkSurface | undefined => state.surfaces.find((s) => isInteractiveSurface(s.kind));

export const workbenchBrowserSurfaces = (
  state: WorkbenchState,
): ReadonlyArray<WorkSurface> => state.surfaces.filter((s) => s.kind === "browser");

export const zoneHasSurfaces = (state: WorkbenchState, zone: WorkZone): boolean =>
  zoneSurfaces(state, zone).length > 0;
