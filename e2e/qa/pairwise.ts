/**
 * Deterministic all-pairs sampling over the registry axes.
 *
 * Axes: surface, action (constrained to the surface's own actions), theme,
 * scale, viewport. Every feasible value pair across any two axes appears in at
 * least one sampled probe; the full cross product is never run. Greedy
 * selection over the feasible tuples, ties broken by enumeration order, so the
 * same registry always yields the same plan.
 */
import {
  CONTEXT_AXES,
  SURFACES,
  type ActionId,
  type ContextAxes,
  type Scale,
  type Surface,
  type Theme,
  type Viewport,
} from "./registry";

export interface Probe {
  /** Stable across runs: `<surface>/<action>/<theme>/<scale>/<viewport>`. */
  readonly id: string;
  readonly surface: string;
  readonly action: ActionId;
  readonly theme: Theme;
  readonly scale: Scale;
  readonly viewport: Viewport;
}

export interface Plan {
  readonly probes: ReadonlyArray<Probe>;
  readonly fullCrossProduct: number;
  readonly pairsCovered: number;
}

const AXES = ["surface", "action", "theme", "scale", "viewport"] as const;
type Axis = (typeof AXES)[number];

const valueOf = (probe: Probe, axis: Axis): string => String(probe[axis]);

const pairKeys = (probe: Probe): string[] => {
  const keys: string[] = [];
  for (let i = 0; i < AXES.length; i += 1) {
    for (let j = i + 1; j < AXES.length; j += 1) {
      const a = AXES[i]!;
      const b = AXES[j]!;
      keys.push(`${a}=${valueOf(probe, a)}|${b}=${valueOf(probe, b)}`);
    }
  }
  return keys;
};

export const probeId = (p: Omit<Probe, "id">): string =>
  `${p.surface}/${p.action}/${p.theme}/${p.scale}/${p.viewport}`;

const feasibleTuples = (surfaces: ReadonlyArray<Surface>, axes: ContextAxes): Probe[] => {
  const tuples: Probe[] = [];
  for (const surface of surfaces) {
    for (const action of surface.actions) {
      for (const theme of axes.theme) {
        for (const scale of axes.scale) {
          for (const viewport of axes.viewport) {
            const base = { surface: surface.id, action, theme, scale, viewport };
            tuples.push({ ...base, id: probeId(base) });
          }
        }
      }
    }
  }
  return tuples;
};

export const pairwisePlan = (
  surfaces: ReadonlyArray<Surface> = SURFACES,
  axes: ContextAxes = CONTEXT_AXES,
): Plan => {
  const tuples = feasibleTuples(surfaces, axes);
  const uncovered = new Set(tuples.flatMap(pairKeys));
  const pairsCovered = uncovered.size;
  const chosen: Probe[] = [];
  const remaining = [...tuples];
  while (uncovered.size > 0) {
    let bestIndex = -1;
    let bestGain = 0;
    for (let i = 0; i < remaining.length; i += 1) {
      const gain = pairKeys(remaining[i]!).filter((key) => uncovered.has(key)).length;
      if (gain > bestGain) {
        bestGain = gain;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    const [pick] = remaining.splice(bestIndex, 1);
    chosen.push(pick!);
    for (const key of pairKeys(pick!)) uncovered.delete(key);
  }
  return { probes: chosen, fullCrossProduct: tuples.length, pairsCovered };
};
