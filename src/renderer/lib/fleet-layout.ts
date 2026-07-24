import { GREEN, HUE } from "./theme";

// Pure fleet-overlay layout math. No React/Effect deps — unit-tested.
// The Command Center node is NOT part of orbit input; the caller pins it at
// (0, 0). Hosts are distributed on concentric orbits with golden-angle spread
// so positions are deterministic and visually uniform for any id set.

export interface FleetNodePosition {
  readonly x: number;
  readonly y: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.39996 rad
const ORBIT_BASE_RADIUS = 260;
const ORBIT_BASE_CAPACITY = 6;

const orbitOf = (sortedIndex: number): { orbit: number; slot: number } => {
  let remaining = sortedIndex;
  let orbit = 0;
  for (;;) {
    const capacity = ORBIT_BASE_CAPACITY * (orbit + 1);
    if (remaining < capacity) return { orbit, slot: remaining };
    remaining -= capacity;
    orbit += 1;
  }
};

/**
 * Deterministic concentric-orbit positions for host ids (sorted first).
 * Orbit capacity is 6, then 12, then 18…; radius is 260 * (orbitIndex + 1);
 * the golden angle spreads nodes within and across orbits.
 */
export const orbitLayout = (
  hostIds: ReadonlyArray<string>,
): Record<string, FleetNodePosition> => {
  const sorted = [...new Set(hostIds)].sort();
  const positions: Record<string, FleetNodePosition> = {};
  sorted.forEach((id, index) => {
    const { orbit } = orbitOf(index);
    const radius = ORBIT_BASE_RADIUS * (orbit + 1);
    const angle = index * GOLDEN_ANGLE;
    positions[id] = {
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
    };
  });
  return positions;
};

export type FleetEdgeStatus =
  | "unknown"
  | "probing"
  | "reachable"
  | "unreachable";

export interface FleetEdgeVisual {
  readonly hue: string;
  readonly dash: string | null;
  readonly animated: boolean;
  readonly width: number;
}

const UNKNOWN_GRAY = "#6b6f76";

/** Edge paint per probe status — mirrors canvas edge conventions. */
export const edgePhase = (status: FleetEdgeStatus): FleetEdgeVisual => {
  switch (status) {
    case "probing":
      return { hue: HUE.cyan, dash: "2 6", animated: true, width: 1 };
    case "reachable":
      return { hue: GREEN, dash: null, animated: false, width: 1.5 };
    case "unreachable":
      return { hue: HUE.crimson, dash: "6 4", animated: false, width: 1 };
    case "unknown":
      return { hue: UNKNOWN_GRAY, dash: "4 6", animated: false, width: 1 };
  }
};

/** Deep-field accent rotation for fleet host nodes. */
export const FLEET_COLORS: readonly string[] = [
  HUE.amber,
  HUE.cyan,
  HUE.violet,
  GREEN,
  HUE.gold,
  HUE.orange,
  HUE.indigo,
  HUE.steel,
];

/** Lucide icon names available as fleet host glyphs. */
export const FLEET_GLYPHS: readonly string[] = [
  "satellite",
  "rocket",
  "globe",
  "star",
  "orbit",
  "radar",
  "cpu",
  "server",
];

const hashId = (id: string): number => {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash;
};

/** appearance.color wins; otherwise a deterministic hue from the id. */
export const hostColor = (host: {
  readonly id: string;
  readonly appearance?: { readonly color?: string };
}): string =>
  host.appearance?.color ??
  FLEET_COLORS[hashId(host.id) % FLEET_COLORS.length]!;
