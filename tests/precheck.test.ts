/**
 * The writing machine's check before it queues a command (`precheck`, plan
 * 02 audit item 4): a refusal no later ruling can lift is answered at once,
 * with the domain's own refusal; anything the editing machine might rule
 * otherwise is queued. `definite` is opt-in per domain.
 */
import { describe, expect, it } from "vitest";
import type { ActorSeatId } from "../src/shared/actor-seat";
import { type ArtifactOp, type ArtifactVersion, emptyBody } from "../src/shared/artifact";
import { artifactDomain, emptyArtifactState } from "../src/shared/artifact-domain";
import type { InstallationId } from "../src/shared/installation-id";
import { localBodyRef } from "../src/renderer/lib/artifacts-source";
import { asNodeId } from "../src/shared/physics/schema";
import {
  commandKey,
  emptyRuled,
  type ItemId,
  mintItemId,
  mintOpId,
  type OpId,
  precheck,
  refusalError,
  type ResourceActor,
  type ResourceCommand,
  type ResourceDomain,
  rule,
  type RulingContext,
} from "../src/shared/resource-command";
import { taskDomain, type TaskBoardState, type TaskDomainEnv, type TaskRecord } from "../src/shared/task-machine";
import {
  CLOSED_TASK_STATES,
  TASK_STATES,
  isOpenTaskState,
  seatNodeId,
  taskNodeId,
  taskNumber,
  type TaskCommand,
  type TaskCommandKind,
  type TaskState,
} from "../src/shared/task-model";

const mini = "mini" as InstallationId;
const everywhere: RulingContext = { inReach: () => true };
const nowhere: RulingContext = { inReach: () => false };
const operator: ResourceActor = { kind: "operator" };

// ── a stand-in domain ──────────────────────────────────────────────────────

// An item is held by at most one seat; `bad` is refused for its own shape.
type Op = { readonly kind: "hold" } | { readonly kind: "bad" };
type Fact = { readonly item: ItemId };
type State = ReadonlySet<ItemId>;

const holdRule: ResourceDomain<State, Op, Fact>["rule"] = (state, { op, target }) => {
  const item = target.itemId!;
  if (op.kind === "bad") return { kind: "refuse", refusal: { reason: "invalid_input", message: "Not a command", next_step: "Send a hold" } };
  return state.has(item)
    ? { kind: "refuse", refusal: { reason: "already_held", message: "Held already" } }
    : { kind: "apply", facts: [{ item }] };
};
const apply = (state: State, fact: Fact): State => new Set(state).add(fact.item);

/** No `definite`: as a new domain lands. */
const plain: ResourceDomain<State, Op, Fact> = { kind: "task", rule: holdRule, apply };
/** Its shape refusal is definite, and, to show the preview is never ruled on, a hold too. */
const sure: ResourceDomain<State, Op, Fact> = { ...plain, definite: () => true };

const tasks = asNodeId("tasks");
const command = <O>(op: O, itemId: ItemId, after: ReadonlyArray<OpId> = [], actor: ResourceActor = operator): ResourceCommand<O> => ({
  opId: mintOpId(),
  canvasName: "factory",
  actor,
  target: { kind: "task", nodeId: tasks, itemId },
  basis: null,
  after,
  op,
});

describe("precheck", () => {
  it("refuses a definite refusal at once with the domain's own refusal, rooted at itself", () => {
    const bad = command<Op>({ kind: "bad" }, mintItemId());
    expect(precheck(sure, emptyRuled(new Set()), mini, [], bad, everywhere)).toEqual({
      kind: "refused",
      opId: bad.opId,
      error: refusalError({ reason: "invalid_input", message: "Not a command", next_step: "Send a hold" }),
      root: bad.opId,
    });
  });

  it("refuses nothing for a domain without `definite`: a new domain fails toward queueing", () => {
    const item = mintItemId();
    const held = emptyRuled<State, Fact>(new Set([item]));
    expect(precheck(plain, held, mini, [], command<Op>({ kind: "bad" }, item), everywhere)).toBeUndefined();
    expect(precheck(plain, held, mini, [], command<Op>({ kind: "hold" }, item), everywhere)).toBeUndefined();
  });

  it("queues what is refused only on top of the writer's unruled commands", () => {
    const item = mintItemId();
    const mine = command<Op>({ kind: "hold" }, item);
    // The overlay would refuse a second hold, but the first may yet be refused.
    expect(precheck(sure, emptyRuled(new Set()), mini, [mine], command<Op>({ kind: "hold" }, item), everywhere)).toBeUndefined();
  });

  it("refuses a command built on a queued command it finds definitely refused, with that root", () => {
    const item = mintItemId();
    const bad = command<Op>({ kind: "bad" }, item);
    const next = command<Op>({ kind: "hold" }, item, [bad.opId]);
    const refused = precheck(sure, emptyRuled(new Set()), mini, [bad], next, everywhere);
    expect(refused).toMatchObject({ kind: "refused", opId: next.opId, root: bad.opId });
    expect(refused?.error.details).toMatchObject({ reason: "depends_on_refused", from: bad.opId });
  });

  it("refuses a command built on a refused ruling held here, even for a domain without `definite`", () => {
    const item = mintItemId();
    const bad = command<Op>({ kind: "bad" }, item);
    const ruled = rule(plain, emptyRuled<State, Fact>(new Set()), mini, bad, everywhere).ruled;
    const next = command<Op>({ kind: "hold" }, item, [bad.opId]);
    expect(precheck(plain, ruled, mini, [], next, everywhere)).toMatchObject({ kind: "refused", root: bad.opId });
  });

  it("queues a command out of reach here: reach can grow before it is ruled", () => {
    expect(precheck(sure, emptyRuled(new Set()), mini, [], command<Op>({ kind: "bad" }, mintItemId()), nowhere)).toBeUndefined();
  });

  it("leaves a resend to the queue that already holds or ruled it", () => {
    const bad = command<Op>({ kind: "bad" }, mintItemId());
    expect(precheck(sure, emptyRuled(new Set()), mini, [bad], bad, everywhere)).toBeUndefined();
    const ruled = rule(sure, emptyRuled<State, Fact>(new Set()), mini, bad, everywhere).ruled;
    expect(ruled.rulings.has(commandKey(mini, bad.opId))).toBe(true);
    expect(precheck(sure, ruled, mini, [], bad, everywhere)).toBeUndefined();
  });
});

// ── the task domain ────────────────────────────────────────────────────────

const ada = seatNodeId(asNodeId("seat-ada"));
const bo = seatNodeId(asNodeId("seat-bo"));
const build = taskNodeId(asNodeId("tasks-build"));
const adaActor: ResourceActor = { kind: "seat", seatId: `seat_${"a".repeat(64)}` as ActorSeatId, nodeId: ada };
const T1 = mintItemId();
const T2 = mintItemId();

const env: TaskDomainEnv = {
  at: 1_000,
  downstream: () => [],
  stampDefaultOf: () => ({ required: 0 }),
  seatReaches: () => true,
  automationReaches: () => true,
};
const domain = taskDomain(env);

const record = (state: TaskState, over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: T1,
  number: taskNumber(1)!,
  title: "ship it",
  dependsOn: [],
  state,
  node: build,
  epoch: 0,
  stampPolicy: { required: 0 },
  reviewers: [],
  stamps: [],
  ...(state !== "backlog" && isOpenTaskState(state) ? { assignee: ada } : {}),
  ...(state === "archived" ? { archivedFrom: "done" as const } : {}),
  ...over,
});

const board = (...records: ReadonlyArray<TaskRecord>) =>
  emptyRuled<TaskBoardState, never>({ tasks: new Map(records.map((task) => [task.id, task])), nextNumber: taskNumber(records.length + 1)! });

/** One command of every kind, so a new kind fails the typecheck here until it is listed. */
const EVERY_COMMAND: { readonly [K in TaskCommandKind]: Extract<TaskCommand, { readonly kind: K }> } = {
  create: { kind: "create", taskId: T1, title: "again" },
  edit: { kind: "edit", title: "renamed" },
  assign: { kind: "assign", seat: bo },
  unassign: { kind: "unassign" },
  start: { kind: "start" },
  pause: { kind: "pause" },
  resume: { kind: "resume" },
  finish: { kind: "finish" },
  check: { kind: "check", results: [] },
  cancel: { kind: "cancel" },
  archive: { kind: "archive" },
  depend: { kind: "depend", on: T2 },
  undepend: { kind: "undepend", on: T2 },
  "reviewer-add": { kind: "reviewer-add", reviewer: { kind: "operator" } },
  "reviewer-remove": { kind: "reviewer-remove", reviewer: { kind: "operator" } },
  "stamp-policy": { kind: "stamp-policy", required: 1 },
  stamp: { kind: "stamp", verdict: "approve" },
};

const taskCommand = (op: TaskCommand, actor: ResourceActor = operator, itemId: ItemId = T1): ResourceCommand<TaskCommand> =>
  ({ ...command(op, itemId, [], actor), target: { kind: "task", nodeId: build, itemId: op.kind === "create" ? op.taskId : itemId } });

const ACTORS: ReadonlyArray<ResourceActor> = [operator, adaActor];

describe("task refusals a writer refuses at once", () => {
  // The lock for marking a closed-state refusal definite: no command, by anyone, rules a closed task into another state but archived.
  it("never leaves a closed state for any state but archived", () => {
    const other = record("done", { id: T2, number: taskNumber(2)! });
    for (const state of CLOSED_TASK_STATES) {
      for (const op of Object.values(EVERY_COMMAND)) {
        for (const actor of ACTORS) {
          const { ruled } = rule(domain, board(record(state), other), mini, taskCommand(op, actor), everywhere);
          expect([state, "archived"]).toContain(ruled.state.tasks.get(T1)!.state);
        }
      }
    }
  });

  it("refuses on archived every command it refuses on done or canceled", () => {
    const other = record("done", { id: T2, number: taskNumber(2)! });
    for (const from of ["done", "canceled"] as const) {
      for (const op of Object.values(EVERY_COMMAND)) {
        for (const actor of ACTORS) {
          const there = rule(domain, board(record(from), other), mini, taskCommand(op, actor), everywhere).ruling;
          if (there.kind !== "refused") continue;
          const archived = rule(domain, board(record("archived", { archivedFrom: from }), other), mini, taskCommand(op, actor), everywhere).ruling;
          expect(archived.kind).toBe("refused");
        }
      }
    }
  });

  it("refuses at once an invalid transition from each closed state, with the task's own words", () => {
    for (const state of CLOSED_TASK_STATES) {
      const start = taskCommand({ kind: "start" }, adaActor);
      const refused = precheck(domain, board(record(state, { assignee: ada })), mini, [], start, everywhere);
      expect(refused?.error.details).toMatchObject({ reason: "invalid_transition", expected: { kind: "illegal-transition", from: state } });
      expect(refused?.error.message).toMatch(/^This task is /);
    }
  });

  it("refuses at once a create of a task that exists, and a stamp policy out of shape", () => {
    expect(precheck(domain, board(record("backlog")), mini, [], taskCommand(EVERY_COMMAND.create), everywhere)?.error.details)
      .toMatchObject({ reason: "invalid_input", expected: { kind: "task-exists" } });
    expect(precheck(domain, board(record("backlog")), mini, [], taskCommand({ kind: "stamp-policy", required: -1 }), everywhere)?.error.details)
      .toMatchObject({ expected: { kind: "invalid-policy" } });
  });

  it("queues every refusal that reads state a later ruling may change", () => {
    const open = TASK_STATES.filter(isOpenTaskState);
    for (const state of open) {
      for (const op of Object.values(EVERY_COMMAND)) {
        if (op.kind === "create" || op.kind === "stamp-policy") continue;
        for (const actor of ACTORS) {
          expect(precheck(domain, board(record(state)), mini, [], taskCommand(op, actor), everywhere)).toBeUndefined();
        }
      }
    }
    // A task not held here may be one the editing machine has ruled since.
    expect(precheck(domain, board(), mini, [], taskCommand({ kind: "start" }, adaActor), everywhere)).toBeUndefined();
  });
});

// ── the artifact domain ────────────────────────────────────────────────────

describe("artifact refusals a writer refuses at once", () => {
  const artifacts = artifactDomain({ now: () => 1_000, bodyRef: localBodyRef });
  const node = asNodeId("artifacts");
  const artifactCommand = (op: ArtifactOp, itemId: ItemId): ResourceCommand<ArtifactOp> =>
    ({ ...command(op, itemId), target: { kind: "artifact", nodeId: node, itemId } });
  const created = () => {
    const id = mintItemId();
    const { ruled } = rule(artifacts, emptyRuled(emptyArtifactState()), mini, artifactCommand({ op: "create", title: "Doc", body: emptyBody("document") }, id), everywhere);
    return { id, ruled };
  };

  it("refuses at once a create of an artifact that exists", () => {
    const { id, ruled } = created();
    const again = artifactCommand({ op: "create", title: "Again", body: emptyBody("document") }, id);
    expect(precheck(artifacts, ruled, mini, [], again, everywhere)?.error.details).toMatchObject({ reason: "invalid_input" });
  });

  it("queues an edit on a stale base and a write to an archived artifact: the head and archive move", () => {
    const { id, ruled } = created();
    const stale = artifactCommand({ op: "edit", edit: { kind: "replace", baseVersion: 7 as ArtifactVersion, body: { type: "document", markdown: "x" } } }, id);
    expect(precheck(artifacts, ruled, mini, [], stale, everywhere)).toBeUndefined();
    const archived = rule(artifacts, ruled, mini, artifactCommand({ op: "archive" }, id), everywhere).ruled;
    expect(precheck(artifacts, archived, mini, [], artifactCommand({ op: "retitle", title: "x" }, id), everywhere)).toBeUndefined();
  });
});
