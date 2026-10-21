import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import { emptyRuled, mintOpId, rule, type ResourceCommand } from "../src/shared/resource-command";
import type { InstallationId } from "../src/shared/installation-id";
import type { ActorSeatId } from "../src/shared/actor-seat";
import {
  currentApprovals,
  emptyTaskBoard,
  oneOpenTaskViolations,
  ruleTaskBoardCommand,
  taskDomain,
  type TaskBoardState,
  type TaskDomainEnv,
  type TaskFact,
  type TaskRecord,
} from "../src/shared/task-machine";
import {
  ASSIGNEE_ONLY,
  isClosedTaskState,
  isOpenTaskState,
  reviewerKey,
  seatNodeId,
  taskNodeId,
  taskNumber as toNumber,
  type Reviewer,
  type TaskActor,
  type TaskCommand,
  type TaskId,
  type TaskState,
} from "../src/shared/task-model";
import { ItemId } from "../src/shared/work-ids";

// The task machine under random command sequences: every ruling is checked
// against the invariants of plan 04 (one assignee, one open task per seat,
// only the assignee transitions, closed states stay closed) and the moves
// the diagram draws. Seeded: a failure names the seed that replays it.

const rng = (seed: number) => {
  let s = seed >>> 0;
  return (below: number): number => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) % below;
};

const SEATS = ["ada", "bo", "cy"].map((n) => seatNodeId(asNodeId(`seat-${n}`)));
const NODES = ["build", "qa", "ship"].map((n) => taskNodeId(asNodeId(`tasks-${n}`)));
const FLOWS = new Map([[NODES[0]!, [NODES[1]!, NODES[2]!]], [NODES[1]!, [NODES[2]!]]]);
const ULIDS = Array.from({ length: 6 }, (_, i) => ItemId.make(`01JZ00000000000000000000${String(i).padStart(2, "0")}`));

const envOf = (seed: number): TaskDomainEnv => ({
  at: 1_000 + seed,
  downstream: (node) => FLOWS.get(node) ?? [],
  stampDefaultOf: (node) => ({ required: Math.min(NODES.indexOf(node) + 1, 2) }),
  seatReaches: (seat, node) => (SEATS.indexOf(seat) + NODES.indexOf(node)) % 4 !== 3,
});

type Step = { readonly actor: TaskActor; readonly node: (typeof NODES)[number]; readonly taskId: TaskId; readonly command: TaskCommand };

const randomSteps = (seed: number, length: number): ReadonlyArray<Step> => {
  const next = rng(seed);
  const pick = <T,>(list: ReadonlyArray<T>): T => list[next(list.length)]!;
  const steps: Step[] = [];
  let created = 0;
  for (let i = 0; i < length; i++) {
    const actor: TaskActor = next(4) === 0 ? { kind: "operator" } : next(11) === 0 ? { kind: "automation", automation: asNodeId("auto") } : { kind: "seat", seat: pick(SEATS) };
    const node = next(2) === 0 ? pick(NODES) : NODES[0]!;
    const reviewer: Reviewer = next(4) === 0 ? { kind: "operator" } : { kind: "seat", seat: pick(SEATS) };
    const taskId = created === 0 || (created < ULIDS.length && next(5) === 0) ? ULIDS[created++]! : ULIDS[next(created)]!;
    const roll = next(100);
    const command: TaskCommand =
      roll < 12 && created > 0 && steps.every((s) => s.command.kind !== "create" || s.taskId !== taskId) ? { kind: "create", taskId, title: "t", ...(next(3) === 0 ? { stampPolicy: { required: next(3) } } : {}) }
      : roll < 22 ? { kind: "assign", seat: pick(SEATS) }
      : roll < 25 ? { kind: "unassign" }
      : roll < 33 ? { kind: "start" }
      : roll < 39 ? { kind: "pause" }
      : roll < 47 ? { kind: "resume" }
      : roll < 57 ? { kind: "finish", ...(next(5) !== 0 ? { next: pick(NODES.slice(1)) } : {}) }
      : roll < 60 ? { kind: "cancel" }
      : roll < 63 ? { kind: "archive" }
      : roll < 69 ? { kind: "reviewer-add", reviewer }
      : roll < 72 ? { kind: "reviewer-remove", reviewer }
      : roll < 76 ? { kind: "stamp-policy", required: next(5) - 1 }
      : roll < 92 ? { kind: "stamp", verdict: next(3) === 0 ? "changes" : "approve" }
      : roll < 96 ? { kind: "depend", on: pick(ULIDS) }
      : { kind: "undepend", on: pick(ULIDS) };
    steps.push({ actor, node, taskId, command });
  }
  return steps;
};

const stepFirst = (steps: ReadonlyArray<Step>): ReadonlyArray<Step> => {
  // Every walk opens with a create so most commands have a task to act on.
  const first = ULIDS[0]!;
  return [{ actor: { kind: "operator" }, node: NODES[0]!, taskId: first, command: { kind: "create", taskId: first, title: "t" } }, ...steps];
};

const asActor = (reviewer: Reviewer): TaskActor => (reviewer.kind === "operator" ? { kind: "operator" } : { kind: "seat", seat: reviewer.seat });

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

/** Walks a seeded sequence through the board, calling `observe` with each ruling. */
const walk = (
  seed: number,
  observe: (before: TaskBoardState, after: TaskBoardState, step: Step, applied: boolean, record: TaskRecord | undefined) => void,
): TaskBoardState => {
  const env = envOf(seed);
  let board = emptyTaskBoard();
  const next = rng(seed ^ 0x9e3779b9);
  for (const generated of stepFirst(randomSteps(seed, 40))) {
    // Most writers know who they are: the assignee moves its task, a reviewer stamps.
    const held = board.tasks.get(generated.taskId);
    const actor: TaskActor =
      held !== undefined && next(5) !== 0 && ASSIGNEE_ONLY[generated.command.kind] && held.assignee !== undefined
        ? { kind: "seat", seat: held.assignee }
        : generated.command.kind === "stamp" && next(3) === 0
          ? { kind: "operator" }
          : held !== undefined && next(5) !== 0 && generated.command.kind === "stamp" && held.reviewers.length > 0
            ? asActor(held.reviewers[next(held.reviewers.length)]!)
            : generated.actor;
    const step: Step = { ...generated, actor, node: held?.node ?? generated.node };
    const ruling = ruleTaskBoardCommand(board, { node: step.node, taskId: step.taskId }, step.actor, step.command, env);
    const after: TaskBoardState = ruling.ok
      ? {
        tasks: new Map(board.tasks).set(ruling.task.id, ruling.task),
        nextNumber: ruling.effects.some((e) => e.kind === "number-minted") ? taskNumber(ruling.task.number + 1) : board.nextNumber,
      }
      : board;
    observe(board, after, step, ruling.ok, ruling.ok ? ruling.task : undefined);
    board = after;
  }
  return board;
};

const taskNumber = (n: number) => toNumber(n)!;

const forall = (check: (seed: number) => ReadonlyArray<string>) => () => {
  const violations: string[] = [];
  for (const seed of SEEDS) for (const v of check(seed)) if (violations.length < 10) violations.push(`seed ${seed}: ${v}`);
  expect(violations).toEqual([]);
};

/** The moves the diagram draws, by the state a task leaves and the state it lands on (sent on lands in backlog). */
const MOVES: Readonly<Record<TaskState, ReadonlyArray<TaskState>>> = {
  backlog: ["backlog", "assigned", "canceled"],
  assigned: ["assigned", "working", "backlog", "canceled"],
  working: ["working", "input-required", "in-review", "done", "backlog", "canceled"],
  "input-required": ["input-required", "working", "backlog", "canceled"],
  "in-review": ["in-review", "working", "done", "backlog", "canceled"],
  done: ["done", "archived"],
  canceled: ["canceled", "archived"],
  archived: ["archived"],
};

describe("task machine properties", () => {
  it("holds the invariants after every ruling: one open task per seat, open means assigned, backlog means nobody", forall((seed) => {
    const out: string[] = [];
    walk(seed, (_, after, step) => {
      const violations = oneOpenTaskViolations(after.tasks.values());
      if (violations.length > 0) out.push(`${step.command.kind}: seat holds ${violations[0]!.taskIds.length} open tasks`);
      for (const task of after.tasks.values()) {
        if (isOpenTaskState(task.state) && task.assignee === undefined) out.push(`${task.id} ${task.state} without an assignee after ${step.command.kind}`);
        if (task.state === "backlog" && task.assignee !== undefined) out.push(`${task.id} backlog with assignee after ${step.command.kind}`);
      }
    });
    return out;
  }));

  it("moves a task only along the diagram, and a closed task only to archived", forall((seed) => {
    const out: string[] = [];
    walk(seed, (before, after, step, applied) => {
      if (!applied) return;
      const prior = before.tasks.get(step.taskId);
      const now = after.tasks.get(step.taskId);
      if (prior === undefined || now === undefined) return;
      if (!MOVES[prior.state].includes(now.state)) out.push(`${prior.state} -> ${now.state} by ${step.command.kind}`);
      if (isClosedTaskState(prior.state) && now.state !== prior.state && now.state !== "archived") out.push(`closed ${prior.state} left to ${now.state}`);
    });
    return out;
  }));

  it("lets only the assignee start, pause, resume and finish, on its open task", forall((seed) => {
    const out: string[] = [];
    walk(seed, (before, _, step, applied) => {
      if (!applied || !ASSIGNEE_ONLY[step.command.kind]) return;
      const prior = before.tasks.get(step.taskId)!;
      if (step.actor.kind !== "seat" || step.actor.seat !== prior.assignee || !isOpenTaskState(prior.state)) {
        out.push(`${step.command.kind} by ${step.actor.kind} on ${prior.state} assignee ${String(prior.assignee)}`);
      }
    });
    return out;
  }));

  it("numbers tasks 1, 2, 3 in the order they are created, and never renumbers one", forall((seed) => {
    const out: string[] = [];
    const seen = new Map<TaskId, number>();
    const final = walk(seed, (before, after, step, applied, record) => {
      if (!applied || record === undefined) return;
      const prior = before.tasks.get(record.id);
      if (step.command.kind === "create") {
        if (record.number !== before.nextNumber) out.push(`create minted ${record.number}, expected ${before.nextNumber}`);
        seen.set(record.id, record.number);
      } else if (prior !== undefined && prior.number !== record.number) out.push(`${record.id} renumbered ${prior.number} -> ${record.number}`);
      if (after.nextNumber !== taskNumber(after.tasks.size + 1)) out.push(`nextNumber ${after.nextNumber} with ${after.tasks.size} tasks`);
    });
    const numbers = [...final.tasks.values()].map((t) => t.number).sort((a, b) => a - b);
    if (numbers.some((n, i) => n !== i + 1)) out.push(`numbers not 1..n: ${numbers.join(",")}`);
    return out;
  }));

  it("raises the epoch only when changes are asked or the task is sent on, by one each, and a sent-on layer starts clean", forall((seed) => {
    const out: string[] = [];
    walk(seed, (before, _, step, applied, record) => {
      if (!applied || record === undefined) return;
      const prior = before.tasks.get(record.id);
      if (prior === undefined) return;
      const sentOn = record.node !== prior.node;
      const changesAsked = step.command.kind === "stamp" && step.command.verdict === "changes" && record.state === "working";
      if (record.epoch < prior.epoch) out.push(`epoch fell on ${step.command.kind}`);
      if (record.epoch !== prior.epoch + (sentOn || changesAsked ? 1 : 0)) {
        out.push(`epoch ${prior.epoch} -> ${record.epoch} on ${step.command.kind} (sentOn ${sentOn}, changesAsked ${changesAsked})`);
      }
      if (sentOn && (record.stamps.length !== 0 || record.state !== "backlog" || record.assignee !== undefined || record.reviewers.length !== 0)) {
        out.push(`sent-on layer is not clean: ${record.state}, ${record.stamps.length} stamps`);
      }
    });
    return out;
  }));

  it("takes a stamp only in review, never from the assignee, and counts each reviewer once", forall((seed) => {
    const out: string[] = [];
    walk(seed, (before, after, step, applied) => {
      if (applied && step.command.kind === "stamp") {
        const prior = before.tasks.get(step.taskId)!;
        if (prior.state !== "in-review") out.push(`stamp taken in ${prior.state}`);
        if (step.actor.kind === "seat" && step.actor.seat === prior.assignee) out.push("assignee stamped its own task");
        if (step.actor.kind === "automation") out.push("automation stamped");
      }
      for (const task of after.tasks.values()) {
        const reviewers = new Set(task.stamps.filter((s) => s.epoch === task.epoch).map((s) => reviewerKey(s.reviewer)));
        if (currentApprovals(task) > reviewers.size) out.push(`${task.id} counts more approvals than reviewers`);
      }
    });
    return out;
  }));

  it("keeps dependencies acyclic, with none on itself or on a task that does not exist", forall((seed) => {
    const out: string[] = [];
    walk(seed, (_, after) => {
      for (const task of after.tasks.values()) {
        if (task.dependsOn.includes(task.id)) out.push(`${task.id} depends on itself`);
        if (new Set(task.dependsOn).size !== task.dependsOn.length) out.push(`${task.id} lists a dependency twice`);
        for (const on of task.dependsOn) if (!after.tasks.has(on)) out.push(`${task.id} depends on missing ${on}`);
      }
      const color = new Map<TaskId, 1 | 2>();
      const visit = (id: TaskId): boolean => {
        if (color.get(id) === 2) return false;
        if (color.get(id) === 1) return true;
        color.set(id, 1);
        const cyclic = (after.tasks.get(id)?.dependsOn ?? []).some(visit);
        color.set(id, 2);
        return cyclic;
      };
      for (const id of after.tasks.keys()) if (visit(id)) out.push(`cycle through ${id}`);
    });
    return out;
  }));

  it("leaves the board as it was when a command is refused, and rules the same sequence the same way twice", forall((seed) => {
    const out: string[] = [];
    const a = walk(seed, (before, after, _, applied) => {
      if (!applied && after !== before) out.push("refused ruling changed the board");
    });
    const b = walk(seed, () => undefined);
    const dump = (board: TaskBoardState) => JSON.stringify([board.nextNumber, [...board.tasks]]);
    if (dump(a) !== dump(b)) out.push("the same sequence ruled two ways");
    return out;
  }));
});

describe("the walks are not vacuous", () => {
  it("apply every command kind, reach every state, send tasks on and ask for changes", () => {
    const applied = new Set<string>();
    const reached = new Set<string>();
    let sentOn = 0;
    let changes = 0;
    for (const seed of SEEDS) {
      walk(seed, (before, after, step, ok, record) => {
        if (!ok || record === undefined) return;
        applied.add(step.command.kind);
        reached.add(record.state);
        const prior = before.tasks.get(record.id);
        if (prior !== undefined && prior.node !== record.node) sentOn += 1;
        if (prior !== undefined && record.epoch > prior.epoch) changes += 1;
        void after;
      });
    }
    expect([...applied].sort()).toEqual(
      ["archive", "assign", "cancel", "create", "depend", "finish", "pause", "resume", "reviewer-add", "reviewer-remove", "stamp", "stamp-policy", "start", "unassign", "undepend"].sort(),
    );
    expect([...reached].sort()).toEqual(["archived", "assigned", "backlog", "canceled", "done", "in-review", "input-required", "working"]);
    expect(sentOn).toBeGreaterThan(0);
    expect(changes).toBeGreaterThan(0);
  });
});

describe("approvals across a change of assignee", () => {
  // A stamp is the reviewer's verdict on the work at an epoch. Unassigning and
  // assigning another seat changes who does the work without moving the epoch.
  // A seat's own stamp never counts toward a task it is assigned (3095a6fff).
  it("does not let a seat's earlier approval count once that seat is assigned the task", () => {
    const [ada, bo] = SEATS;
    const env = envOf(0);
    const id = ULIDS[0]!;
    const apply = (board: TaskBoardState, actor: TaskActor, command: TaskCommand, node = NODES[0]!) => {
      const ruling = ruleTaskBoardCommand(board, { node, taskId: id }, actor, command, env);
      if (!ruling.ok) throw new Error(`${command.kind} refused: ${JSON.stringify(ruling.refusal.detail)}`);
      return { tasks: new Map(board.tasks).set(id, ruling.task), nextNumber: board.nextNumber } as TaskBoardState;
    };
    const op: TaskActor = { kind: "operator" };
    let board = apply(emptyTaskBoard(), op, { kind: "create", taskId: id, title: "t", stampPolicy: { required: 1 } });
    board = apply(board, op, { kind: "reviewer-add", reviewer: { kind: "seat", seat: bo! } });
    board = apply(board, op, { kind: "assign", seat: ada! });
    board = apply(board, { kind: "seat", seat: ada! }, { kind: "start" });
    board = apply(board, { kind: "seat", seat: ada! }, { kind: "finish", next: NODES[1]! });
    expect(board.tasks.get(id)!.state).toBe("in-review");
    // bo approves: that meets the count of one, so the task is done. Use a count of two to keep it in review.
    board = apply(board, op, { kind: "stamp-policy", required: 2 });
    board = apply(board, { kind: "seat", seat: bo! }, { kind: "stamp", verdict: "approve" });
    expect(board.tasks.get(id)!.state).toBe("in-review");
    board = apply(board, op, { kind: "unassign" });
    board = apply(board, op, { kind: "assign", seat: bo! });
    board = apply(board, { kind: "seat", seat: bo! }, { kind: "start" });
    const current = board.tasks.get(id)!;
    // bo is now the assignee; its approval of the earlier work must not count toward this task.
    expect(current.assignee).toBe(bo);
    expect(currentApprovals({ ...current, reviewers: current.reviewers })).toBe(0);
  });
});

describe("a task that returns to a node it already passed", () => {
  it("inherits none of that node's old approvals", () => {
    const [ada] = SEATS;
    const [a, b] = NODES;
    const id = ULIDS[0]!;
    const op: TaskActor = { kind: "operator" };
    const seatOf: TaskActor = { kind: "seat", seat: ada! };
    let flows = new Map([[a!, [b!]]]);
    const env: TaskDomainEnv = { ...envOf(0), downstream: (node) => flows.get(node) ?? [], stampDefaultOf: () => ({ required: 1 }) };
    const apply = (board: TaskBoardState, actor: TaskActor, command: TaskCommand, node: (typeof NODES)[number]) => {
      const ruling = ruleTaskBoardCommand(board, { node, taskId: id }, actor, command, env);
      if (!ruling.ok) throw new Error(`${command.kind} refused: ${JSON.stringify(ruling.refusal.detail)}`);
      return { tasks: new Map(board.tasks).set(id, ruling.task), nextNumber: board.nextNumber } as TaskBoardState;
    };
    const through = (board: TaskBoardState, node: (typeof NODES)[number]) => {
      let next = apply(board, op, { kind: "assign", seat: ada! }, node);
      next = apply(next, seatOf, { kind: "start" }, node);
      next = apply(next, seatOf, { kind: "finish" }, node);
      expect(next.tasks.get(id)!.state).toBe("in-review");
      return apply(next, op, { kind: "stamp", verdict: "approve" }, node);
    };
    let board = apply(emptyTaskBoard(), op, { kind: "create", taskId: id, title: "t" }, a!);
    board = through(board, a!);
    const atB = board.tasks.get(id)!;
    expect([atB.node, atB.state, atB.stamps.length]).toEqual([b, "backlog", 0]);
    flows = new Map([[b!, [a!]]]);
    board = through(board, b!);
    const back = board.tasks.get(id)!;
    expect([back.node, back.state, back.stamps.length]).toEqual([a, "backlog", 0]);
    expect(back.epoch).toBe(2);
    expect(currentApprovals(back)).toBe(0);
    // Even a stamp left over from the first pass, at the first pass's epoch, counts for nothing.
    const stale = { ...back, stamps: [{ reviewer: { kind: "operator" as const }, verdict: "approve" as const, epoch: 0, at: 1 }] };
    expect(currentApprovals(stale)).toBe(0);
  });
});

describe("task domain under the ruler, out of reach", () => {
  const writer = "mini" as InstallationId;
  const seatActor = (seat: ReturnType<typeof seatNodeId>) => ({ kind: "seat" as const, seatId: `seat_${"a".repeat(64)}` as ActorSeatId, nodeId: seat });

  it("admits only the assignee's own transitions on its open task when nothing is in reach", forall((seed) => {
    const out: string[] = [];
    const env = envOf(seed);
    const domain = taskDomain(env);
    let ruled = emptyRuled<TaskBoardState, TaskFact>(emptyTaskBoard());
    // Build state with everything in reach, then replay a second pass with none.
    for (const step of stepFirst(randomSteps(seed, 25))) {
      ruled = rule(domain, ruled, writer, commandOf(step, seatActor), { inReach: () => true }).ruled;
    }
    const board = ruled.state;
    for (const step of randomSteps(seed + 10_000, 40)) {
      const prior = board.tasks.get(step.taskId);
      const result = rule(domain, emptyRuled<TaskBoardState, TaskFact>(board), writer, commandOf(step, seatActor), { inReach: () => false });
      if (result.ruling.kind !== "applied") continue;
      const exempt = prior !== undefined && ASSIGNEE_ONLY[step.command.kind] && step.actor.kind === "seat" && step.actor.seat === prior.assignee && isOpenTaskState(prior.state);
      if (!exempt) out.push(`${step.command.kind} by ${step.actor.kind} applied out of reach`);
    }
    return out;
  }));
});

const commandOf = (
  step: Step,
  seatActor: (seat: ReturnType<typeof seatNodeId>) => { kind: "seat"; seatId: ActorSeatId; nodeId: ReturnType<typeof seatNodeId> },
): ResourceCommand<TaskCommand> => ({
  opId: mintOpId(),
  canvasName: "factory",
  actor: step.actor.kind === "seat" ? seatActor(step.actor.seat) : step.actor.kind === "operator" ? { kind: "operator" } : { kind: "automation", nodeId: step.actor.automation, automationId: ULIDS[0]! },
  target: { kind: "task", nodeId: step.node, ...(step.command.kind === "create" ? {} : { itemId: step.taskId }) },
  basis: null,
  after: [],
  op: step.command,
});
