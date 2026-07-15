import { Notification } from "electron";
import type { SnapshotState } from "@shared/entities";

// Booth attention: a macOS notification the moment a booth project starts
// owing MORE human verdicts than it already did — the push half of the
// review loop (the canvas decal is the pull half). Runs in main off the
// snapshot poll, so it works headless: no window has to be open for the
// operator to learn a draft is waiting.

export interface BoothAttentionAlert {
  readonly projectKey: string;
  readonly pending: number;
  readonly delta: number;
}

export interface BoothAttentionState {
  // pending_review per booth project key, as of the last OK booth bundle.
  readonly counts: ReadonlyMap<string, number>;
  readonly alerts: ReadonlyArray<BoothAttentionAlert>;
}

// Pure rising-edge detector.
//
// - The first OK booth bundle observed is the baseline: it produces counts
//   but NO alerts (a restart must not re-announce drafts already waiting).
// - After baseline, a project alerts only when its pending count RISES
//   (new key counts as rising from 0). Falling/steady stays silent —
//   reviews being done is not news.
// - A not-ok booth bundle (server down/unreachable) keeps the previous
//   counts untouched: entities vanishing on an outage must not zero the
//   baselines, or recovery would re-announce every waiting draft.
export const computeBoothAttention = (
  previous: ReadonlyMap<string, number> | undefined,
  state: SnapshotState,
): BoothAttentionState => {
  const bundle = state.bundles.find((candidate) => candidate.source === "booth");
  if (!bundle || !bundle.ok) {
    return { counts: previous ?? new Map(), alerts: [] };
  }

  const counts = new Map<string, number>();
  for (const entity of bundle.entities) {
    const pending = entity.stats.pending_review;
    if (typeof pending === "number") counts.set(entity.key, pending);
  }

  if (previous === undefined) return { counts, alerts: [] };

  const alerts: BoothAttentionAlert[] = [];
  for (const [projectKey, pending] of counts) {
    const before = previous.get(projectKey) ?? 0;
    if (pending > before) alerts.push({ projectKey, pending, delta: pending - before });
  }
  return { counts, alerts };
};

const notifyAlert = (alert: BoothAttentionAlert): void => {
  if (!Notification.isSupported()) return;
  const noun = alert.delta === 1 ? "draft" : "drafts";
  new Notification({
    title: `booth · ${alert.projectKey}`,
    body: `${alert.delta} new ${noun} ready for review (${alert.pending} waiting)`,
    silent: false,
  }).show();
};

// Wire the detector onto a snapshot subscription. Returns the unsubscribe.
export const startBoothAttention = (
  subscribe: (listener: (state: SnapshotState) => void) => () => void,
  notify: (alert: BoothAttentionAlert) => void = notifyAlert,
): (() => void) => {
  let counts: ReadonlyMap<string, number> | undefined;
  return subscribe((state) => {
    const next = computeBoothAttention(counts, state);
    // Baseline only sticks once booth has answered OK at least once —
    // computeBoothAttention returns previous(=undefined→empty) counts on a
    // not-ok bundle, and `undefined` must survive until a real baseline.
    const bundle = state.bundles.find((candidate) => candidate.source === "booth");
    if (bundle?.ok === true) counts = next.counts;
    for (const alert of next.alerts) notify(alert);
  });
};
