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
 * - `onAnswer`: the operator answered an automation's signal (0.11/09). The
 *   raising automation delivers the answer where its step's `answerTo` says,
 *   recorded as its own firing keyed by the signal, so it is delivered once.
 *   Off or at its limits, it still delivers: the operator answered.
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
  type CodeOutput,
  type Automation,
  type AutomationId,
  type Condition,
  type Firing,
  type FiringCause,
  type FiringId,
  targetNodeIds,
} from "@shared/automation";
import type { NodeId } from "@shared/physics/schema";
import type { HostId } from "@shared/remote-hosts";
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
  /** Whether this machine runs the automation: the one it names, or the editing machine when it names none. */
  readonly runsHere: (canvasName: string, automation: Automation) => boolean;
  /** This machine's own short name, which a firing minted here names as its machine (S3). */
  readonly machineName?: (canvasName: string) => HostId | undefined;
  /** The canvas count this machine's copy stands at: the count a claim is minted under (S3). */
  readonly claimSeq?: (canvasName: string) => number | undefined;
};

/**
 * The action that delivers an answer (0.11/09): a prompt to the seat, a new
 * document, or a dated section. Its text names the answer's values, never
 * the answer's words, so what the operator wrote is never read for values.
 */
export const answerDelivery = (
  answerTo: NonNullable<Extract<Action, { readonly kind: "signal" }>["answerTo"]>,
  hasLink: boolean,
): Action => {
  const said = `{{answer.text}}${hasLink ? "\n\n{{answer.link}}" : ""}`;
  switch (answerTo.kind) {
    case "seat":
      return { kind: "prompt", to: answerTo.to, text: `The operator answered the {{signal.kind}} signal "{{signal.title}}":\n\n${said}` };
    case "document":
      return { kind: "create-artifact", node: answerTo.node, title: answerTo.title, body: said };
    case "append":
      return { kind: "append-artifact", to: answerTo.to, text: `## {{answer.at|date:YYYY-MM-DD HH:mm}}\n\n${said}` };
    default:
      return answerTo satisfies never;
  }
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
  readonly onAnswer: (
    canvasName: string,
    event: Extract<ChangeEvent, { readonly kind: "answered" }>,
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
    // The machine and the claim's count are minted with the id: only this
    // machine ever writes this firing's revisions, judged where the
    // automation ran at that count (S3).
    const machine = ports.machineName?.(canvasName);
    const claimSeq = ports.claimSeq?.(canvasName);
    const firing: Firing = {
      firingId: ports.mintFiringId(),
      automationId: automation.automationId,
      at: now,
      cause,
      outcome: decision.kind === "fire" ? { kind: "claimed" } : { kind: "skipped", reason: decision.reason },
      ...(machine === undefined ? {} : { machine }),
      ...(claimSeq === undefined ? {} : { claimSeq }),
    };
    const claim = yield* repository.claimFiring(canvasName, firing);
    if (claim._tag === "Duplicate") return undefined;
    if (decision.kind !== "fire") return firing;
    const actions: Array<ActionRuling> = [];
    // What the code steps so far answered: `{{code.<field>}}` for the steps after them, the later field winning.
    let code: CodeOutput = {};
    for (const [index, action] of automation.then.entries()) {
      // A move folded while this firing was in flight: what is left is the new machine's, never performed here.
      const held = (yield* repository.loadState(canvasName)).get(automation.automationId);
      if (held === undefined || held.archived || !ports.runsHere(canvasName, held.automation)) {
        actions.push({
          index,
          ruling: "refused",
          reason: "not_permitted",
          // A move only when it went somewhere else: an archived one, or one this machine stopped holding, moved nowhere.
          ...(held === undefined || held.archived || held.automation.machine === undefined || held.automation.machine === automation.machine
            ? {}
            : { movedTo: held.automation.machine }),
        });
        continue;
      }
      const ruled = yield* ports.perform(canvasName, automation, action, index, firing.firingId, { event, at: now, cause: cause.kind, code });
      actions.push(ruled);
      if (action.kind !== "code") continue;
      // A code step that stopped, failed or was not admitted runs no later step.
      if (ruled.ruling !== "continued") break;
      code = { ...code, ...ruled.output };
    }
    const outcome = { kind: "fired", actions } as const;
    yield* repository.settleFiring(canvasName, firing, outcome);
    return { ...firing, outcome };
  });

  const live = Effect.fn("AutomationRunner.live")(function* (canvasName: string) {
    const repository = yield* AutomationRepository;
    const state = yield* repository.loadState(canvasName);
    // Only the machine an automation names runs it, so none fires twice.
    return [...state.values()]
      .filter((entry) => !entry.archived && ports.runsHere(canvasName, entry.automation))
      .map((entry) => entry.automation);
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

  const onAnswer = Effect.fn("AutomationRunner.onAnswer")(function* (
    canvasName: string,
    event: Extract<ChangeEvent, { readonly kind: "answered" }>,
  ) {
    const automation = (yield* live(canvasName)).find((candidate) => candidate.automationId === event.automationId);
    if (automation === undefined) return undefined;
    // The step by its id, so an edit that moved it still finds it. Every step with an answerTo has one
    // (minted at save); a signal raised before that is found where it stood.
    const index = event.step === undefined
      ? event.index ?? -1
      : automation.then.findIndex((action) => action.kind === "signal" && action.id === event.step);
    const step = automation.then[index];
    if (step?.kind !== "signal" || step.answerTo === undefined) return undefined;
    const response = event.signal.response;
    const delivery = answerDelivery(step.answerTo, response?.artifact !== undefined || (response?.links ?? []).length > 0);
    const targets = targetsOf(canvasName, automation);
    const now = ports.now();
    const inReach = targetNodeIds({ ...automation, then: [delivery] }).every((id) => targets.has(id));
    const repository = yield* AutomationRepository;
    const machine = ports.machineName?.(canvasName);
    const claimSeq = ports.claimSeq?.(canvasName);
    const firing: Firing = {
      firingId: ports.mintFiringId(),
      automationId: automation.automationId,
      at: now,
      cause: { kind: "change", key: `answer:${event.signal.signalId}` },
      outcome: inReach ? { kind: "claimed" } : { kind: "skipped", reason: "out_of_reach" },
      ...(machine === undefined ? {} : { machine }),
      ...(claimSeq === undefined ? {} : { claimSeq }),
    };
    const claim = yield* repository.claimFiring(canvasName, firing);
    if (claim._tag === "Duplicate" || !inReach) return claim._tag === "Duplicate" ? undefined : firing;
    const ruled = yield* ports.perform(canvasName, automation, delivery, index, firing.firingId, {
      event,
      at: now,
      cause: "change",
      delivering: true,
    });
    const outcome = { kind: "fired", actions: [ruled] } as const;
    yield* repository.settleFiring(canvasName, firing, outcome);
    return { ...firing, outcome };
  });

  return { tick, onChange, onRun, onAnswer };
};
