import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import {
  ASSIGNEE_ONLY,
  blocksAssignee,
  CLOSED_TASK_STATES,
  formatTaskNumber,
  isClosedTaskState,
  isOpenTaskState,
  LEGACY_TASK_STATES,
  OPEN_TASK_STATES,
  parseTaskNumber,
  reachExempt,
  remapLegacyTaskState,
  seatNodeId,
  TASK_REFUSAL_REASON,
  TASK_STATES,
  taskNumber,
  taskRefusal,
  type LegacyTaskState,
  type TaskActor,
  type TaskCommand,
  type TaskCommandKind,
  type TaskRefusalDetail,
  type TaskState,
} from "../src/shared/task-model";
import { RefusalReason } from "../src/shared/resource-command";

// The task contract, exhaustively where it is finite and by seeded property
// where it is not, beside the worked examples in task-model.test.ts.

const SEAT = seatNodeId(asNodeId("agent-1"));
const OTHER = seatNodeId(asNodeId("agent-2"));

/** One command of every kind, so a new kind without a row here fails tsc through `Record`. */
const COMMANDS: { readonly [K in TaskCommandKind]: Extract<TaskCommand, { kind: K }> } = {
  create: { kind: "create", taskId: "01M5ETKKW2KX682NBXQZYA69MY" as never, title: "t" },
  edit: { kind: "edit" },
  assign: { kind: "assign", seat: SEAT },
  unassign: { kind: "unassign" },
  start: { kind: "start" },
  pause: { kind: "pause" },
  resume: { kind: "resume" },
  finish: { kind: "finish" },
  check: { kind: "check", results: [{ checkId: "tests", side: "outgoing", command: "bun test", exitCode: 0, outputTail: "" }] },
  cancel: { kind: "cancel" },
  archive: { kind: "archive" },
  depend: { kind: "depend", on: "01M5ETKKW2KX682NBXQZYA69MZ" as never },
  undepend: { kind: "undepend", on: "01M5ETKKW2KX682NBXQZYA69MZ" as never },
  "reviewer-add": { kind: "reviewer-add", reviewer: { kind: "operator" } },
  "reviewer-remove": { kind: "reviewer-remove", reviewer: { kind: "operator" } },
  "stamp-policy": { kind: "stamp-policy", required: 1 },
  stamp: { kind: "stamp", verdict: "approve" },
};
const KINDS = Object.keys(COMMANDS) as TaskCommandKind[];

const ACTORS: ReadonlyArray<readonly [string, TaskActor]> = [
  ["assignee seat", { kind: "seat", seat: SEAT }],
  ["other seat", { kind: "seat", seat: OTHER }],
  ["operator", { kind: "operator" }],
  ["automation", { kind: "automation", automation: asNodeId("auto") }],
];

describe("task states", () => {
  it("partition into backlog, open and closed with no overlap and no gap", () => {
    const all = [...OPEN_TASK_STATES, ...CLOSED_TASK_STATES, "backlog"].sort();
    expect(all).toEqual([...TASK_STATES].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("only blocks the assignee in an open state", () => {
    for (const state of TASK_STATES) if (blocksAssignee(state)) expect(isOpenTaskState(state), state).toBe(true);
  });
});

describe("reachExempt, exhaustively", () => {
  it("holds only for the assignee seat on its own open task, and only for assignee-only commands", () => {
    const violations: string[] = [];
    for (const state of TASK_STATES) for (const kind of KINDS) for (const [who, actor] of ACTORS) {
      for (const assignee of [SEAT, undefined]) {
        const exempt = reachExempt({ state, assignee }, actor, COMMANDS[kind]);
        const expected = ASSIGNEE_ONLY[kind] && who === "assignee seat" && assignee === SEAT && isOpenTaskState(state);
        if (exempt !== expected) violations.push(`${state} ${kind} by ${who} assignee=${String(assignee)}: ${exempt}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("never exempts a task without an assignee, even for a command only an assignee writes", () => {
    for (const state of TASK_STATES) for (const kind of KINDS) for (const [, actor] of ACTORS) {
      expect(reachExempt({ state, assignee: undefined }, actor, COMMANDS[kind]), `${state} ${kind}`).toBe(false);
    }
  });
});

describe("legacy state remap", () => {
  const LEGACY: ReadonlyArray<LegacyTaskState> = LEGACY_TASK_STATES;

  it("lands every stored state on a 0.10 state, whichever way the assignee flag falls", () => {
    for (const state of LEGACY) for (const hasAssignee of [false, true]) {
      expect(TASK_STATES, `${state} ${hasAssignee}`).toContain(remapLegacyTaskState(state, hasAssignee));
    }
  });

  it("reads the assignee flag only for states that need someone to move them", () => {
    const needsSomeone = new Set<LegacyTaskState>(["submitted", "working", "input-required", "auth-required"]);
    for (const state of LEGACY.filter((s) => !needsSomeone.has(s))) {
      expect(remapLegacyTaskState(state, true), state).toBe(remapLegacyTaskState(state, false));
    }
  });

  it("keeps finished work finished and live work live", () => {
    for (const state of ["completed", "canceled", "failed", "rejected", "archived"] as const) {
      expect(isClosedTaskState(remapLegacyTaskState(state, true)), state).toBe(true);
    }
    for (const state of ["working", "input-required", "auth-required"] as const) {
      expect(isOpenTaskState(remapLegacyTaskState(state, true)), state).toBe(true);
    }
  });

  it("never invents a review: nothing stored maps to in-review", () => {
    for (const state of LEGACY) for (const hasAssignee of [false, true]) {
      expect(remapLegacyTaskState(state, hasAssignee), state).not.toBe("in-review");
    }
  });

  // Invariant 3: only the assignee moves an open task, and `assign` needs
  // backlog, so an open task with nobody on it is stuck.
  it("leaves no open task without an assignee, and every live row with one keeps its state", () => {
    for (const state of LEGACY) expect(isOpenTaskState(remapLegacyTaskState(state, false)), state).toBe(false);
    for (const state of ["working", "input-required", "auth-required"] as const) {
      expect(remapLegacyTaskState(state, true), state).toBe(state === "working" ? "working" : "input-required");
    }
  });
});

describe("task refusals", () => {
  const DETAILS: { readonly [K in TaskRefusalDetail["kind"]]: Extract<TaskRefusalDetail, { kind: K }> } = {
    "illegal-transition": { kind: "illegal-transition", from: "done", command: "start" },
    "not-assignee": { kind: "not-assignee" },
    "already-assigned": { kind: "already-assigned", assignee: SEAT },
    "not-reviewer": { kind: "not-reviewer", reviewer: { kind: "operator" } },
    "own-task": { kind: "own-task", seat: SEAT },
    "stale-epoch": { kind: "stale-epoch", expected: 2 },
    "next-required": { kind: "next-required", choices: [] },
    "next-not-downstream": { kind: "next-not-downstream", next: "n" as never, choices: [] },
    "invalid-policy": { kind: "invalid-policy", required: -1 },
    "dependency-cycle": { kind: "dependency-cycle", through: [] },
    "unknown-task": { kind: "unknown-task", taskId: "01M5ETKKW2KX682NBXQZYA69MY" as never },
    "task-exists": { kind: "task-exists", taskId: "01M5ETKKW2KX682NBXQZYA69MY" as never },
    "cannot-review": { kind: "cannot-review", actor: "automation" },
    "target-mismatch": { kind: "target-mismatch", target: "01M5ETKKW2KX682NBXQZYA69MY" as never, taskId: "01M5ETKKW2KX682NBXQZYA69MZ" as never },
    "wrong-node": { kind: "wrong-node", nodeId: asNodeId("n"), expected: "agent" },
    "not-in-reach": { kind: "not-in-reach", nodeId: asNodeId("n") },
    "rules-unmet": { kind: "rules-unmet", missing: "claim", message: "Rule r1 needs a claim", nextStep: "Finish with a claim for r1", ruleId: "r1" },
    "checks-unmet": { kind: "checks-unmet", red: ["tests"], missing: [] },
    "deps-unmet": {
      kind: "deps-unmet",
      unfinished: [{ taskId: "01M5ETKKW2KX682NBXQZYA69MY" as never, number: 2 as never, state: "working" }],
    },
  };

  it("sends every detail under a closed wire reason and keeps the detail whole", () => {
    for (const detail of Object.values(DETAILS)) {
      const refusal = taskRefusal(detail);
      expect(RefusalReason.literals, detail.kind).toContain(refusal.reason);
      expect(refusal.reason).toBe(TASK_REFUSAL_REASON[detail.kind]);
      expect(refusal.detail).toBe(detail);
    }
  });

  it("uses every retryable wire reason only for a stale epoch", () => {
    const retryable = new Set(["stale", "rebase_conflict", "queue_full"]);
    const toRetryable = Object.entries(TASK_REFUSAL_REASON).filter(([, reason]) => retryable.has(reason)).map(([kind]) => kind);
    expect(toRetryable).toEqual(["stale-epoch"]);
  });
});

describe("task numbers", () => {
  const rng = (seed: number) => {
    let s = seed >>> 0;
    return (below: number) => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) % below;
  };

  it("round-trips every number through its written form, with or without the prefix and spacing", () => {
    const next = rng(7);
    for (let i = 0; i < 500; i++) {
      const value = 1 + next(1_000_000);
      const n = taskNumber(value)!;
      expect(parseTaskNumber(formatTaskNumber(n))).toBe(n);
      expect(parseTaskNumber(` ${value} `)).toBe(n);
      expect(parseTaskNumber(`#${value}`)).toBe(n);
    }
  });

  it("refuses what is not a whole number from 1, including numbers past the safe range", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(taskNumber(bad), String(bad)).toBeUndefined();
    for (const bad of ["#0", "00", "1e3", "0x10", "# 4", "#4 2", "T-42", "٤٢", "9".repeat(16)]) expect(parseTaskNumber(bad), bad).toBeUndefined();
  });
});
