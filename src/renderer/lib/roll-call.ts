/**
 * Region roll call — situation buckets from a RegionRollup.
 * Not a member directory: only non-zero hot severities, worst first.
 */
import type { MemberSeverity, MemberStatus, RegionRollup } from "@shared/region-rollup";

/** Hot ladder for roll call. Idle never surfaces as its own bucket. */
export const ROLL_CALL_BUCKETS = ["blocked", "attention", "working", "parked"] as const;
export type RollCallSeverity = (typeof ROLL_CALL_BUCKETS)[number];

export type RollCallBucket = {
  readonly severity: RollCallSeverity;
  readonly count: number;
  /** Up to `nameLimit` member labels in document/severity order. */
  readonly names: ReadonlyArray<string>;
  /** Members beyond the named set. */
  readonly extra: number;
};

export type RollCallModel =
  | { readonly kind: "empty" }
  | { readonly kind: "quiet"; readonly total: number }
  | { readonly kind: "hot"; readonly total: number; readonly buckets: ReadonlyArray<RollCallBucket> };

const NAME_LIMIT = 2;

const countParked = (members: ReadonlyArray<MemberStatus>): number =>
  members.reduce((n, m) => (m.severity === "parked" ? n + 1 : n), 0);

const namesFor = (
  members: ReadonlyArray<MemberStatus>,
  severity: MemberSeverity,
  limit: number,
): { readonly names: string[]; readonly extra: number } => {
  const matched = members.filter((m) => m.severity === severity);
  const names = matched.slice(0, limit).map((m) => m.label);
  return { names, extra: Math.max(0, matched.length - names.length) };
};

/**
 * Build the roll-call model for a region rollup.
 * - empty region → empty
 * - all idle (no blocked/attention/working/parked) → quiet
 * - otherwise → hot buckets with counts + sample names
 */
export function buildRollCall(
  rollup: RegionRollup,
  nameLimit: number = NAME_LIMIT,
): RollCallModel {
  const total = rollup.counts.total;
  if (total === 0) return { kind: "empty" };

  const parked = countParked(rollup.members);
  const counts: Record<RollCallSeverity, number> = {
    blocked: rollup.counts.blocked,
    attention: rollup.counts.attention,
    working: rollup.counts.working,
    parked,
  };

  const buckets: RollCallBucket[] = [];
  for (const severity of ROLL_CALL_BUCKETS) {
    const count = counts[severity];
    if (count <= 0) continue;
    const { names, extra } = namesFor(rollup.members, severity, nameLimit);
    buckets.push({ severity, count, names, extra });
  }

  if (buckets.length === 0) return { kind: "quiet", total };
  return { kind: "hot", total, buckets };
}

/** Full-word label for a hot bucket (no abbreviations, no middot glue). */
export function rollCallBucketLabel(severity: RollCallSeverity, count: number): string {
  if (count === 1) {
    switch (severity) {
      case "blocked":
        return "1 blocked";
      case "attention":
        return "1 attention";
      case "working":
        return "1 working";
      case "parked":
        return "1 parked";
    }
  }
  switch (severity) {
    case "blocked":
      return `${count} blocked`;
    case "attention":
      return `${count} attention`;
    case "working":
      return `${count} working`;
    case "parked":
      return `${count} parked`;
  }
}
