import { GREEN, HUE } from "./theme";

// Pure fleet-overlay layout math. No React/Effect deps — unit-tested.
// The Command Center node is NOT part of orbit input; the caller pins it at
// (0, 0). Enrolled stations occupy balanced rings. Discovered peers live in a
// separate mesh band because visibility is not a Command Center route.

export interface FleetNodePosition {
  readonly x: number;
  readonly y: number;
}

export const ORBIT_BASE_RADIUS = 300;
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
 * `startOrbit` pushes the whole set outward (unclaimed peers orbit beyond
 * the enrolled fleet).
 */
export const orbitLayout = (
  hostIds: ReadonlyArray<string>,
  startOrbit = 0,
): Record<string, FleetNodePosition> => {
  const sorted = [...new Set(hostIds)].sort();
  const positions: Record<string, FleetNodePosition> = {};
  const rings = new Map<number, string[]>();
  sorted.forEach((id, index) => {
    const { orbit } = orbitOf(index);
    const ring = rings.get(orbit) ?? [];
    ring.push(id);
    rings.set(orbit, ring);
  });
  for (const [orbit, ids] of rings) {
    const radius = ORBIT_BASE_RADIUS * (startOrbit + orbit + 1);
    const phase = orbit % 2 === 0 ? 0 : Math.PI / Math.max(ids.length, 1);
    ids.forEach((id, slot) => {
      const angle = phase + (slot / ids.length) * Math.PI * 2;
      positions[id] = {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      };
    });
  }
  return positions;
};

export const DISCOVERY_COLUMN_GAP = 230;
export const DISCOVERY_ROW_GAP = 230;
const DISCOVERY_ROWS = 4;

/**
 * Discovered peers are observational, not enrolled routes. Keep them in a
 * quiet band beyond the fleet instead of threading false edges through it.
 */
export const discoveryLayout = (
  peerIds: ReadonlyArray<string>,
  startX: number,
): Record<string, FleetNodePosition> => {
  const sorted = [...new Set(peerIds)].sort();
  const positions: Record<string, FleetNodePosition> = {};
  sorted.forEach((id, index) => {
    const column = Math.floor(index / DISCOVERY_ROWS);
    const row = index % DISCOVERY_ROWS;
    const rowsInColumn = Math.min(DISCOVERY_ROWS, sorted.length - column * DISCOVERY_ROWS);
    positions[id] = {
      x: startX + column * DISCOVERY_COLUMN_GAP,
      y: (row - (rowsInColumn - 1) / 2) * DISCOVERY_ROW_GAP,
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

const UNKNOWN_GRAY = HUE.steel;

/** Edge paint per probe status — mirrors canvas edge conventions. */
export const edgePhase = (status: FleetEdgeStatus): FleetEdgeVisual => {
  switch (status) {
    case "probing":
      return { hue: HUE.cyan, dash: "2 7", animated: true, width: 1.35 };
    case "reachable":
      return { hue: GREEN, dash: null, animated: false, width: 1.6 };
    case "unreachable":
      return { hue: HUE.crimson, dash: "7 5", animated: false, width: 1.4 };
    case "unknown":
      return { hue: UNKNOWN_GRAY, dash: "3 7", animated: false, width: 1.1 };
  }
};

/** Accent rotation for fleet host nodes. */
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

const hashId = (id: string): number => {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash;
};

/** appearance.color wins; otherwise a deterministic hue from the id. */
export const hostColor = (
  host: {
    readonly id: string;
    readonly appearance?: { readonly color?: string };
  },
  automaticColor?: string,
): string =>
  host.appearance?.color ??
  automaticColor ??
  FLEET_COLORS[hashId(host.id) % FLEET_COLORS.length]!;
