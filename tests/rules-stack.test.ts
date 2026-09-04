import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type {
  CompletionEvidence,
  Rule,
  Task,
  TaskRule,
  TasksContract,
  Visit,
} from "../src/shared/work-model";
import {
  claimIsLive,
  claimsRecorded,
  clampRequestedAdmission,
  computeWaitUntil,
  effectiveTaskAdmission,
  evaluateChecks,
  evaluateForkWaivers,
  evaluateRules,
  evaluateTerminalClose,
  requiredChecks,
  rulesInForce,
  taskAdmissionState,
  taskEpoch,
} from "../src/shared/rules";
import { WAIT_FOR_MAX_MS } from "../src/shared/work-control";

const rule = (id: string, text = `rule ${id}`): Rule => ({ id, text });

const taskRule = (id: string, board: string): TaskRule => ({
  id,
  text: `task rule ${id}`,
  board,
});

const board = (
  id: string,
  contract?: TasksContract,
  items: ReadonlyArray<Task> = [],
): CanvasNode => ({
  id,
  type: "text",
  text: "tasks",
  x: 300,
  y: 300,
  width: 100,
  height: 60,
  ether: {
    entity: { kind: "task" },
    tasks: {
      items: [...items],
      ...(contract !== undefined ? { contract } : {}),
    },
  },
});

const region = (
  id: string,
  rect: { x: number; y: number; width: number; height: number },
  rules?: ReadonlyArray<Rule>,
  label?: string,
): CanvasNode => ({
  id,
  type: "group",
  ...rect,
  ...(label !== undefined ? { label } : {}),
  ether: {
    region: {
      ...(rules !== undefined ? { contract: { rules: [...rules] } } : {}),
    },
  },
});

const flowEdge = (id: string, source: string, destination: string) => ({
  id,
  fromNode: source,
  toNode: destination,
  ether: { verb: "feeds" as const },
});

const baseTask = (id: string, extra?: Partial<Task>): Task => ({
  id,
  state: "working",
  history: [],
  ...extra,
});

const evidence = (
  claims: ReadonlyArray<{ ruleId: string; text: string }>,
  waivers: ReadonlyArray<{ ruleId: string; reason: string }> = [],
): CompletionEvidence => ({
  artifacts: [],
  ...(claims.length > 0 ? { claims: [...claims] } : {}),
  ...(waivers.length > 0 ? { waivers: [...waivers] } : {}),
});

describe("rulesInForce", () => {
  it("stacks region rules outer to inner, then board rules, then task rules for this board", () => {
    const doc: CanvasDoc = {
      nodes: [
        region("outer", { x: 0, y: 0, width: 1000, height: 1000 }, [rule("r-outer")], "Outer"),
        region("inner", { x: 200, y: 200, width: 400, height: 400 }, [rule("r-inner")]),
        board("s1", { rules: [rule("s-local")] }),
      ],
      edges: [],
    };
    const task = baseTask("t1", {
      rules: [taskRule("t-here", "s1"), taskRule("t-there", "s2")],
    });
    const stack = rulesInForce(doc, "s1", task);
    expect(stack.map((entry) => entry.rule.id)).toEqual([
      "r-outer",
      "r-inner",
      "s-local",
      "t-here",
    ]);
    expect(stack[0]!.provenance).toEqual({
      kind: "region",
      regionId: "outer",
      label: "Outer",
    });
    expect(stack[2]!.provenance).toEqual({ kind: "board", boardId: "s1" });
    expect(stack[3]!.provenance).toEqual({ kind: "task", board: "s1" });
  });

  it("is empty for a board with no surrounding rules", () => {
    const doc: CanvasDoc = { nodes: [board("s1")], edges: [] };
    expect(rulesInForce(doc, "s1", baseTask("t1"))).toEqual([]);
  });
});

describe("evaluateRules", () => {
  it("demands a claim for every rule in force", () => {
    const rules = [
      { rule: rule("r1"), provenance: { kind: "board" as const, boardId: "s1" } },
      { rule: rule("r2"), provenance: { kind: "board" as const, boardId: "s1" } },
    ];
    expect(evaluateRules({ rules, evidence: undefined })?.ruleId).toBe("r2");
    expect(
      evaluateRules({
        rules,
        evidence: evidence([{ ruleId: "r2", text: "done" }]),
      })?.ruleId,
    ).toBe("r1");
    expect(
      evaluateRules({
        rules,
        evidence: evidence([
          { ruleId: "r1", text: "done" },
          { ruleId: "r2", text: "done" },
        ]),
      }),
    ).toBeUndefined();
  });
});

describe("claim liveness across defects", () => {
  it("shadows claims at or downstream of a defect target and keeps earlier ones", () => {
    const visit = (boardId: string, epoch: number, exit?: Visit["exit"]): Visit => ({
      board: boardId,
      enteredAt: "2026-08-20T10:00:00.000Z",
      epoch,
      ...(exit !== undefined ? { exit } : {}),
    });
    const task = baseTask("t1", {
      epoch: 1,
      visits: [visit("s1", 0, "sent-on"), visit("s2", 0, "sent-on"), visit("s3", 0, "sent-back"), visit("s1", 1, "sent-on"), visit("s2", 1)],
      defects: [{ epoch: 1, target: "s2", at: "2026-08-21T10:00:00.000Z" }],
    });
    expect(claimIsLive(task, task.visits!, task.visits![0]!)).toBe(true);
    expect(claimIsLive(task, task.visits!, task.visits![1]!)).toBe(false);
    expect(claimIsLive(task, task.visits!, task.visits![3]!)).toBe(true);
    expect(taskEpoch(task)).toBe(1);
  });
});

describe("evaluateForkWaivers", () => {
  it("accepts a waiver only when the chosen path no longer reaches the rule's board", () => {
    const doc: CanvasDoc = {
      nodes: [board("s1"), board("s2"), board("s3")],
      edges: [
        flowEdge("e1", "s1", "s2"),
        flowEdge("e2", "s1", "s3"),
      ],
    };
    const task = baseTask("t1", { rules: [taskRule("r1", "s3")] });
    const fork = evaluateForkWaivers({
      doc,
      boardId: "s1",
      task,
      next: "s2",
      evidence: evidence([], [{ ruleId: "r1", reason: "path skips s3" }]),
    });
    expect(fork).toBeUndefined();
    const unreachable = evaluateForkWaivers({
      doc,
      boardId: "s1",
      task,
      next: "s2",
      evidence: undefined,
    });
    expect(unreachable?.missing).toBe("waivers");
  });
});

describe("evaluateTerminalClose", () => {
  it("requires every task rule to be claimed or live-waived", () => {
    const doc: CanvasDoc = { nodes: [board("s1")], edges: [] };
    const task = baseTask("t1", { rules: [taskRule("r1", "s1")] });
    expect(
      evaluateTerminalClose({
        doc,
        boardId: "s1",
        task,
        evidence: evidence([{ ruleId: "r1", text: "done" }]),
      }),
    ).toBeUndefined();
    expect(
      evaluateTerminalClose({ doc, boardId: "s1", task, evidence: undefined })
        ?.missing,
    ).toBe("claims");
  });
});

describe("requiredChecks and evaluateChecks", () => {
  it("runs outgoing checks then the next board's incoming checks", () => {
    const doc: CanvasDoc = {
      nodes: [
        board("s1", {
          outgoing: { checks: [{ id: "k1", label: "typecheck", command: "bun run typecheck" }] },
        }),
        board("s2", {
          incoming: { checks: [{ id: "k2", label: "lint", command: "bun run lint" }] },
        }),
      ],
      edges: [flowEdge("e1", "s1", "s2")],
    };
    expect(requiredChecks(doc, "s1", "s2").map(({ side, check }) => [side, check.id])).toEqual([
      ["outgoing", "k1"],
      ["incoming", "k2"],
    ]);
  });

  it("refuses a check whose result is missing, stale, or failing", () => {
    const task = baseTask("t1", {
      checkResults: [
        {
          checkId: "k1",
          side: "outgoing",
          command: "bun run typecheck",
          exitCode: 1,
          outputTail: "",
          at: "2026-08-20T10:00:00.000Z",
          epoch: 0,
        },
      ],
    });
    const checks = [
      { check: { id: "k1", label: "typecheck", command: "bun run typecheck" }, side: "outgoing" as const },
      { check: { id: "k2", label: "lint", command: "bun run lint" }, side: "incoming" as const },
    ];
    expect(evaluateChecks({ task, checks })?.missing).toBe("checks.failed");
    expect(
      evaluateChecks({ task: baseTask("t1"), checks })?.missing,
    ).toBe("checks");
    expect(
      evaluateChecks({
        task,
        checks: [checks[0]!],
      })?.missing,
    ).toBe("checks.failed");
  });
});

describe("admission", () => {
  it("clamps requested admission to the board floor and defaults agents to approval", () => {
    expect(
      clampRequestedAdmission({ floor: "auto", requested: "auto", omitted: "inherit" }),
    ).toEqual({ ok: true, stamp: "auto" });
    expect(
      clampRequestedAdmission({ floor: "auto", requested: "approval", omitted: "inherit" }),
    ).toEqual({ ok: true, stamp: "approval" });
    expect(
      clampRequestedAdmission({ floor: "approval", requested: "auto", omitted: "inherit" }).ok,
    ).toBe(false);
    expect(
      clampRequestedAdmission({ floor: "auto", requested: undefined, omitted: "approval" }),
    ).toEqual({ ok: true, stamp: "approval" });
    expect(
      clampRequestedAdmission({ floor: "operator", requested: undefined, omitted: "approval" }),
    ).toEqual({ ok: true, stamp: "operator" });
  });

  it("derives the effective admission and live state", () => {
    const contract: TasksContract = { incoming: { admission: "approval" } };
    expect(effectiveTaskAdmission(baseTask("t1"), contract)).toBe("approval");
    expect(effectiveTaskAdmission(baseTask("t1", { admission: "operator" }), contract)).toBe("operator");
    const waiting = baseTask("t1", {
      waitUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(taskAdmissionState(waiting, undefined, Date.now())).toBe("waiting");
    const approved = baseTask("t1", { admission: "approval" });
    expect(taskAdmissionState(approved, undefined, Date.now())).toBe("approval");
  });

  it("computes the wait stamp with the work-plane ceiling", () => {
    expect(computeWaitUntil(1000, undefined, undefined)).toBeUndefined();
    expect(computeWaitUntil(1000, 0, 0)).toBeUndefined();
    expect(computeWaitUntil(1000, 5_000, undefined)).toBe(
      new Date(6000).toISOString(),
    );
    expect(computeWaitUntil(1000, WAIT_FOR_MAX_MS * 2, undefined)).toBe(
      new Date(1000 + WAIT_FOR_MAX_MS).toISOString(),
    );
  });
});

describe("claimsRecorded", () => {
  it("joins claims and waivers from the latest completed visit per board", () => {
    const t1 = baseTask("t1", {
      state: "working",
      visits: [
        { board: "s1", enteredAt: "2026-08-20T10:00:00.000Z", epoch: 0, exit: "sent-on", next: "s2" },
        { board: "s2", enteredAt: "2026-08-20T11:00:00.000Z", epoch: 0 },
      ],
    });
    const s1Row = baseTask("t1", {
      state: "working",
      completionEvidence: evidence([{ ruleId: "r1", text: "ok" }]),
    });
    const doc: CanvasDoc = {
      nodes: [board("s1", undefined, [s1Row]), board("s2")],
      edges: [],
    };
    const recorded = claimsRecorded(doc, t1);
    expect(recorded.claimed.get("r1")?.has("s1")).toBe(true);
  });
});
