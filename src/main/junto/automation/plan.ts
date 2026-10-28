/**
 * The automation runner's decisions, pure (plan 0.10/07 Runner). The runner
 * on the editing machine asks two things on each kernel tick:
 *
 * - `dueSlot`: is a schedule or poll due, and for which slot? A missed
 *   schedule fires once for its latest slot; the earlier slots are counted
 *   and never fire. This is today's cron coalescing (kernel/cycle.ts), keyed
 *   by automation instead of host.
 * - `decide`: given a considered firing, does it fire or skip, and why? A
 *   limit reached skips and records; nothing here disables an automation.
 *
 * The cursor is the last slot the runner considered, fired or skipped, and
 * the next slot is always computed from it, never from now: from now, a
 * fall-back hour would fire twice. The
 * claim on (automation, slot) in `automation_firings` makes a restart unable
 * to fire one slot twice. A new automation's cursor starts at the moment the
 * runner first sees it, so creating one never fires its past slots.
 */
import { nextCronOccurrenceIn } from "@shared/cron-expression";
import type { NodeId } from "@shared/physics/schema";
import type { TaskState } from "@shared/task-model";
import type { ItemId } from "@shared/work-ids";
import {
  type ArtifactEvent,
  type Automation,
  type FiringCause,
  limitSkip,
  type SeatBecomes,
  type SkipReason,
  type Trigger,
  triggerRefusal,
  type Watch,
  type WatchedSignal,
} from "@shared/automation";

/** How many missed slots a catch-up counts before it stops counting. */
export const MISSED_SLOTS_COUNTED = 256;

type Timed = Extract<Trigger, { readonly kind: "schedule" | "poll" }>;

export type SlotDue = {
  /** The cause to record: the latest due slot and how many it coalesced. */
  readonly cause: Extract<FiringCause, { readonly kind: "schedule" | "poll" }>;
};

/** The next slot strictly after `afterEpochMs`, undefined when there is none. */
export const nextSlot = (trigger: Timed, afterEpochMs: number): number | undefined => {
  switch (trigger.kind) {
    case "schedule":
      return nextCronOccurrenceIn(trigger.cron, afterEpochMs, trigger.timezone);
    case "poll":
      return (Math.floor(afterEpochMs / trigger.everyMs) + 1) * trigger.everyMs;
    default:
      return trigger satisfies never;
  }
};

/**
 * The slot due at `now` after `cursor`, with the earlier slots it coalesces,
 * or undefined when nothing is due. `missed` stops counting at
 * MISSED_SLOTS_COUNTED: past that the walk jumps toward `now`, so a lid closed
 * for a month costs a bounded number of steps.
 */
export const dueSlot = (trigger: Timed, cursor: number, now: number): SlotDue | undefined => {
  let latest = nextSlot(trigger, cursor);
  if (latest === undefined || latest > now) return undefined;
  let missed = 0;
  if (trigger.kind === "poll") {
    const last = Math.floor(now / trigger.everyMs) * trigger.everyMs;
    missed = Math.min(MISSED_SLOTS_COUNTED, (last - latest) / trigger.everyMs);
    return { cause: { kind: "poll", slot: last, missed } };
  }
  for (;;) {
    let steps = 0;
    const from = latest;
    for (;;) {
      const following = nextSlot(trigger, latest);
      if (following === undefined || following > now) {
        return { cause: { kind: "schedule", slot: latest, missed: Math.min(missed, MISSED_SLOTS_COUNTED) } };
      }
      latest = following;
      missed += 1;
      steps += 1;
      if (steps >= MISSED_SLOTS_COUNTED) break;
    }
    // Still behind: restart one walked span short of now. That span held at
    // least MISSED_SLOTS_COUNTED slots, so a slot lies inside it.
    const restart = nextSlot(trigger, Math.max(latest, now - (latest - from)));
    if (restart === undefined || restart > now) {
      return { cause: { kind: "schedule", slot: latest, missed: MISSED_SLOTS_COUNTED } };
    }
    latest = restart;
    missed = MISSED_SLOTS_COUNTED;
  }
};

export type Considered = {
  readonly automation: Automation;
  readonly cause: FiringCause;
  readonly now: number;
  /** When this automation last fired; skips are not listed. */
  readonly firedAt: ReadonlyArray<number>;
  /** Every node it names is in `automationTargets` now. */
  readonly inReach: boolean;
  /** Every `when` condition holds now. */
  readonly conditionsHold: boolean;
};

export type Decision = { readonly kind: "fire" } | { readonly kind: "skip"; readonly reason: SkipReason };

/**
 * Fire or skip, in this order: disabled (a manual `run` passes), not
 * available, out of reach, a condition unmet, then the limits.
 */
export const decide = (considered: Considered): Decision => {
  const { automation, cause } = considered;
  const skip = (reason: SkipReason): Decision => ({ kind: "skip", reason });
  if (!automation.enabled && cause.kind !== "run") return skip("disabled");
  if (triggerRefusal(automation.trigger) !== undefined) return skip("not_available");
  if (!considered.inReach) return skip("out_of_reach");
  if (!considered.conditionsHold) return skip("condition_unmet");
  const limited = limitSkip(automation.limits, considered.firedAt, considered.now);
  return limited === undefined ? { kind: "fire" } : skip(limited);
};

/**
 * Whether a raised signal fires a signal watch. With `from`, only that seat's;
 * without, only a seat among `targets` (the automation's `automationTargets`
 * at fire time), so a seat author's automation never hears a sibling region.
 */
export const signalWatchMatches = (
  watch: Extract<Watch, { readonly kind: "signal" }>,
  raised: { readonly signal: WatchedSignal; readonly seat: NodeId },
  targets: ReadonlySet<NodeId>,
): boolean => {
  if (watch.signal !== raised.signal) return false;
  return watch.from === undefined ? targets.has(raised.seat) : watch.from.nodeId === raised.seat;
};

/**
 * Something that happened, as a change trigger hears it. `key` dedupes one
 * transition: seat and epoch for a seat (pty's SeatStateFiring key), the fact
 * id otherwise. `byAutomation` marks a fact an automation's own action wrote:
 * it never triggers an automation (loop safety, 07).
 */
export type ChangeEvent =
  | { readonly kind: "seat"; readonly key: string; readonly seat: NodeId; readonly becomes: SeatBecomes }
  | {
      readonly kind: "task";
      readonly key: string;
      readonly nodeId: NodeId;
      readonly taskId: ItemId;
      readonly becomes: TaskState;
      readonly byAutomation: boolean;
    }
  | {
      readonly kind: "artifact";
      readonly key: string;
      readonly nodeId: NodeId;
      readonly artifactId: ItemId;
      readonly event: ArtifactEvent;
      readonly byAutomation: boolean;
    }
  | { readonly kind: "signal"; readonly key: string; readonly seat: NodeId; readonly signal: WatchedSignal; readonly text: string };

/** Whether a change fires a watch. `targets` are the automation's targets now. */
export const changeMatches = (watch: Watch, event: ChangeEvent, targets: ReadonlySet<NodeId>): boolean => {
  switch (watch.kind) {
    case "seat":
      return event.kind === "seat" && watch.seat.nodeId === event.seat && watch.becomes === event.becomes;
    case "task": {
      if (event.kind !== "task" || event.byAutomation || watch.becomes !== event.becomes) return false;
      if (!("kind" in watch.task)) return watch.task.node === event.nodeId;
      return watch.task.kind === "task" && watch.task.nodeId === event.nodeId && watch.task.taskId === event.taskId;
    }
    case "artifact":
      return (
        event.kind === "artifact" &&
        !event.byAutomation &&
        watch.event === event.event &&
        ("kind" in watch.artifact
          ? watch.artifact.kind === "artifact" && watch.artifact.nodeId === event.nodeId && watch.artifact.artifactId === event.artifactId
          : watch.artifact.node === event.nodeId)
      );
    case "signal":
      return event.kind === "signal" && signalWatchMatches(watch, event, targets);
    default:
      return watch satisfies never;
  }
};
