/**
 * The automation runner (plan 0.10/07), on the editing machine only: one
 * runner evaluates every automation of the canvas, so nothing fires twice and
 * nothing depends on which machine is awake.
 *
 * Three ways in, one way through:
 * - `tick` on the kernel clock: each schedule or poll whose slot came due
 *   since its cursor is considered once for its latest slot (plan.ts).
 * - `onChange`: a seat, task, artifact or signal change, already held and
 *   deduped upstream (pty's seat-state triggers, the fact stream).
 * - `onRun`: the `automation.run` fact of `junto automation run`.
 *
 * Considering a firing rechecks reach against the canvas as it is now, the
 * `when` conditions and the limits (`decide`), then claims the firing in
 * `automation_firings`, so a restart or a second tick cannot repeat it, and
 * only then performs the actions and records how each was ruled.
 *
 * A disabled automation's slots and changes pass without a record: its
 * cursor still moves, so enabling it never fires the slots it slept through.
 * A manual run of a disabled automation fires.
 */
import { Effect } from "effect";
import {
  type Action,
  type ActionRuling,
  type Automation,
  type AutomationId,
  type Condition,
  type Firing,
  type FiringCause,
  type FiringId,
  targetNodeIds,
} from "@shared/automation";
import type { NodeId } from "@shared/physics/schema";
import { automationTargets, type ReachCanvas } from "@shared/region-reach";
import { type ChangeEvent, changeMatches, decide, dueSlot, nextSlot } from "./plan";
import { type AutomationPersistenceError, AutomationRepository } from "./repository";
import type { Fired } from "./values";

const HOUR_MS = 60 * 60_000;

/** What the runner needs from the rest of main. */
export type RunnerPorts = {
  /** The editing machine's canvas, for reach at fire time; undefined when it is not loaded. */
  readonly canvas: (canvasName: string) => ReachCanvas | undefined;
  /** Whether a `when` condition holds now: a seat's held state, a task's state. */
  readonly holds: (canvasName: string, condition: Condition) => boolean;
  /**
   * Perform one action as the automation (`{ kind: "automation" }` actor):
   * mail from the automation's node, or a resource command. Never fails: a
   * refusal is a ruling. `fired` is what its `{{name}}` values read.
   */
  readonly perform: (
    canvasName: string,
    automation: Automation,
    action: Action,
    index: number,
    firingId: FiringId,
    fired: Fired,
  ) => Effect.Effect<ActionRuling>;
  readonly mintFiringId: () => FiringId;
  readonly now: () => number;
};

export type AutomationRunner = {
  readonly tick: (canvasName: string) => Effect.Effect<void, AutomationPersistenceError, AutomationRepository>;
  readonly onChange: (
    canvasName: string,
    event: ChangeEvent,
  ) => Effect.Effect<void, AutomationPersistenceError, AutomationRepository>;
  readonly onRun: (
    canvasName: string,
    automationId: AutomationId,
  ) => Effect.Effect<Firing | undefined, AutomationPersistenceError, AutomationRepository>;
};

export const makeAutomationRunner = (ports: RunnerPorts): AutomationRunner => {
  // The next slot per (automation, version, cursor). A sparse cron walks up
  // to two years of minutes to find it, so it is found once, not every tick.
  const nextSlots = new Map<string, number | undefined>();
  const cachedNextSlot = (automation: Automation, trigger: Parameters<typeof nextSlot>[0], cursor: number) => {
    const key = `${automation.automationId}:${automation.version}:${cursor}`;
    if (!nextSlots.has(key)) {
      for (const stale of nextSlots.keys()) if (stale.startsWith(`${automation.automationId}:`)) nextSlots.delete(stale);
      nextSlots.set(key, nextSlot(trigger, cursor));
    }
    return nextSlots.get(key);
  };

  const targetsOf = (canvasName: string, automation: Automation): ReadonlySet<NodeId> => {
    const canvas = ports.canvas(canvasName);
    if (canvas === undefined) return new Set();
    return new Set(automationTargets(canvas, automation.nodeId, automation.author).map((node) => node.id));
  };

  const consider = Effect.fn("AutomationRunner.consider")(function* (
    canvasName: string,
    automation: Automation,
    cause: FiringCause,
    targets: ReadonlySet<NodeId>,
    event?: ChangeEvent,
  ) {
    const repository = yield* AutomationRepository;
    const now = ports.now();
    const decision = decide({
      automation,
      cause,
      now,
      firedAt: yield* repository.firedSince(canvasName, automation.automationId, now - HOUR_MS),
      inReach: targetNodeIds(automation).every((id) => targets.has(id)),
      conditionsHold: (automation.when ?? []).every((condition) => ports.holds(canvasName, condition)),
    });
    const firing: Firing = {
      firingId: ports.mintFiringId(),
      automationId: automation.automationId,
      at: now,
      cause,
      outcome: decision.kind === "fire" ? { kind: "claimed" } : { kind: "skipped", reason: decision.reason },
    };
    const claim = yield* repository.claimFiring(canvasName, firing);
    if (claim._tag === "Duplicate") return undefined;
    if (decision.kind !== "fire") return firing;
    const actions: Array<ActionRuling> = [];
    for (const [index, action] of automation.then.entries()) {
      actions.push(yield* ports.perform(canvasName, automation, action, index, firing.firingId, { event, at: now }));
    }
    const outcome = { kind: "fired", actions } as const;
    yield* repository.settleFiring(canvasName, firing, outcome);
    return { ...firing, outcome };
  });

  const live = Effect.fn("AutomationRunner.live")(function* (canvasName: string) {
    const repository = yield* AutomationRepository;
    const state = yield* repository.loadState(canvasName);
    return [...state.values()].filter((entry) => !entry.archived).map((entry) => entry.automation);
  });

  const tick = Effect.fn("AutomationRunner.tick")(function* (canvasName: string) {
    const repository = yield* AutomationRepository;
    for (const automation of yield* live(canvasName)) {
      const { trigger } = automation;
      if (trigger.kind !== "schedule" && trigger.kind !== "poll") continue;
      const cursor = yield* repository.cursor(canvasName, automation.automationId);
      if (cursor === undefined) {
        // First sight: start counting from now, so no past slot fires.
        yield* repository.setCursor(canvasName, automation.automationId, ports.now());
        continue;
      }
      const next = cachedNextSlot(automation, trigger, cursor);
      if (next === undefined || next > ports.now()) continue;
      const due = dueSlot(trigger, cursor, ports.now());
      if (due === undefined) continue;
      if (automation.enabled) {
        yield* consider(canvasName, automation, due.cause, targetsOf(canvasName, automation));
      }
      // Always from the slot, never from now: from now a fall-back hour fires twice.
      yield* repository.setCursor(canvasName, automation.automationId, due.cause.slot);
    }
  });

  const onChange = Effect.fn("AutomationRunner.onChange")(function* (canvasName: string, event: ChangeEvent) {
    for (const automation of yield* live(canvasName)) {
      if (!automation.enabled || automation.trigger.kind !== "change") continue;
      const targets = targetsOf(canvasName, automation);
      if (!changeMatches(automation.trigger.on, event, targets)) continue;
      yield* consider(canvasName, automation, { kind: "change", key: event.key }, targets, event);
    }
  });

  const onRun = Effect.fn("AutomationRunner.onRun")(function* (canvasName: string, automationId: AutomationId) {
    const automation = (yield* live(canvasName)).find((candidate) => candidate.automationId === automationId);
    if (automation === undefined) return undefined;
    return yield* consider(canvasName, automation, { kind: "run" }, targetsOf(canvasName, automation));
  });

  return { tick, onChange, onRun };
};
