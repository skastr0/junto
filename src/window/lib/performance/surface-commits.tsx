import { Profiler, type ReactNode } from "react";
import { PERF_ENABLED } from "./perf-flag";

// Which parts of the window commit, and how often, when the performance
// harness is armed. The harness counts commits for the whole window and for
// the canvas; this says which surface inside them did the work, so a run can
// name what re-renders after one act. It records nothing unless the harness is
// armed, and a surface it wraps renders exactly as it would without it.

export type SurfaceCommits = { commits: number; ms: number };

const counts: Record<string, SurfaceCommits> = {};

const record = (id: string, ms: number): void => {
  const entry = (counts[id] ??= { commits: 0, ms: 0 });
  entry.commits += 1;
  entry.ms += Number.isFinite(ms) && ms > 0 ? ms : 0;
};

/** A copy of the counts so far, by surface. Subtract two to see one act. */
export const surfaceCommitsSnapshot = (): Record<string, SurfaceCommits> =>
  Object.fromEntries(Object.entries(counts).map(([id, entry]) => [id, { ...entry }]));

/** Renders of each card, by the name it is counted under and then by its id. */
const byCard: Record<string, Record<string, number>> = {};

/** A copy of the per-card render counts so far. Subtract two to see one act. */
export const cardRendersSnapshot = (): Record<string, Record<string, number>> =>
  Object.fromEntries(Object.entries(byCard).map(([name, cards]) => [name, { ...cards }]));

if (PERF_ENABLED && typeof window !== "undefined") {
  const lab = window as unknown as {
    juntoSurfaceCommits?: () => Record<string, SurfaceCommits>;
    juntoCardRenders?: () => Record<string, Record<string, number>>;
  };
  lab.juntoSurfaceCommits = surfaceCommitsSnapshot;
  lab.juntoCardRenders = cardRendersSnapshot;
}

/** Count the commits of everything inside, under one name. */
export function CountedSurface({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  if (!PERF_ENABLED) return children;
  return (
    <Profiler id={id} onRender={(_id, _phase, actualDuration) => record(id, actualDuration)}>
      {children}
    </Profiler>
  );
}

/**
 * Count one render of a component that is mounted many times, such as a card,
 * under one name for all of them, and under its own id when one is given, so
 * a run can tell ten cards rendered twice from twenty rendered once. Call it
 * in the component's body.
 */
export const countRender = (id: string, card?: string): void => {
  if (!PERF_ENABLED) return;
  record(id, 0);
  if (card === undefined) return;
  const cards = (byCard[id] ??= {});
  cards[card] = (cards[card] ?? 0) + 1;
};
