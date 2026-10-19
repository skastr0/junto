/**
 * Region roll call — situation buckets from a RegionRollup.
 * Not a member directory: only non-zero hot severities, worst first.
 */
import { MemberSeverity, type MemberStatus, type RegionRollup } from "@shared/region-rollup";

/** Hot tiers for roll call, worst first, as the rollup ranks them. Idle never surfaces as its own bucket. */
export type RollCallSeverity = Exclude<MemberSeverity, "idle">;
export const ROLL_CALL_BUCKETS: ReadonlyArray<RollCallSeverity> = MemberSeverity.groups.filter(
  (group): group is RollCallSeverity => group !== MemberSeverity.group.idle,
);

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

const countSeverity = (
  members: ReadonlyArray<MemberStatus>,
  severity: MemberSeverity,
): number => members.reduce((n, m) => (m.severity === severity ? n + 1 : n), 0);

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
 * - all idle (no blocked/attention/working/ready) → quiet
 * - otherwise → hot buckets with counts + sample names
 */
export function buildRollCall(
  rollup: RegionRollup,
  nameLimit: number = NAME_LIMIT,
): RollCallModel {
  const total = rollup.counts.total;
  if (total === 0) return { kind: "empty" };

  const countOf = (severity: RollCallSeverity): number => {
    switch (severity) {
      case MemberSeverity.group.blocked:
        return rollup.counts.blocked;
      case MemberSeverity.group.attention:
        return rollup.counts.attention;
      case MemberSeverity.group.escalated:
        // `escalated` predates this field on cached rollups: recount when it is absent.
        return rollup.counts.escalated ?? countSeverity(rollup.members, severity);
      case MemberSeverity.group.working:
        return rollup.counts.working;
      default:
        // `ready` predates this field on cached rollups: recount when it is absent.
        return rollup.counts.ready ?? countSeverity(rollup.members, severity);
    }
  };

  const buckets: RollCallBucket[] = [];
  for (const severity of ROLL_CALL_BUCKETS) {
    const count = countOf(severity);
    if (count <= 0) continue;
    const { names, extra } = namesFor(rollup.members, severity, nameLimit);
    buckets.push({ severity, count, names, extra });
  }

  if (buckets.length === 0) return { kind: "quiet", total };
  return { kind: "hot", total, buckets };
}

/** Each hot tier's full words, singular and plural, with the count in front. */
const bucketWords = (severity: RollCallSeverity): { readonly one: string; readonly many: string } => {
  switch (severity) {
    case MemberSeverity.group.blocked:
      return { one: "blocked", many: "blocked" };
    case MemberSeverity.group.attention:
      return { one: "attention", many: "attention" };
    case MemberSeverity.group.escalated:
      return { one: "waiting on you", many: "waiting on you" };
    case MemberSeverity.group.working:
      return { one: "working", many: "working" };
    default:
      return { one: "ready", many: "ready" };
  }
};

/** Full-word label for a hot bucket (no abbreviations, no middot glue). */
export function rollCallBucketLabel(severity: RollCallSeverity, count: number): string {
  const words = bucketWords(severity);
  return `${count} ${count === 1 ? words.one : words.many}`;
}
