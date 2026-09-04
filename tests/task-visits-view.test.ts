import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { CheckResult, Rule, Task, Visit } from "../src/shared/work-model";
import type { ActorSeatId } from "../src/shared/actor-seat";
import { makeAgentMessage } from "../src/shared/task";
import {
  buildTaskVisits,
  layerExitLabel,
} from "../src/renderer/components/work/task-visits";

const brief = makeAgentMessage({
  messageId: "m1",
  text: "ship the task path view",
  contextId: "c1",
  taskId: "t1",
});

const task = (nodeId: string, overrides: Partial<Task> = {}): Task => ({
  id: "t1",
  state: "working",
  history: [brief],
  ...overrides,
});

const sink = (id: string, items: ReadonlyArray<Task>, rules?: ReadonlyArray<Rule>): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ether: {
    entity: { kind: "task" },
    tasks: {
      items: [...items],
      name: id,
      ...(rules !== undefined ? { contract: { rules: [...rules] } } : {}),
    },
  },
});

const doc = (nodes: ReadonlyArray<CanvasNode>): CanvasDoc => ({
  nodes: [...nodes],
  edges: [],
});

const visit = (over: Partial<Visit> & Pick<Visit, "board">): Visit => ({
  enteredAt: "2026-08-20T10:00:00.000Z",
  epoch: 0,
  ...over,
});

const checkResult = (over: Partial<CheckResult> & Pick<CheckResult, "checkId">): CheckResult => ({
  side: "outgoing",
  command: "bun run typecheck",
  exitCode: 0,
  outputTail: "",
  at: "2026-08-20T10:30:00.000Z",
  epoch: 0,
  ...over,
});

describe("buildTaskVisits", () => {
  it("returns no layers for a task that never entered a board", () => {
    const board = doc([sink("build", [task("build")])]);
    expect(buildTaskVisits(board, task("build"), "build").layers).toEqual([]);
  });

  it("joins each visit to the claims and checks left on its board row", () => {
    const buildRow = task("build", {
      state: "completed",
      completionEvidence: {
        artifacts: [],
        claims: [{ ruleId: "c1", text: "typechecked", refs: ["src/a.ts"] }],
        waivers: [{ ruleId: "c2", reason: "no ui surface touched" }],
      },
      checkResults: [
        checkResult({ checkId: "k1" }),
        checkResult({ checkId: "k2", exitCode: 1 }),
      ],
    });
    const current = task("review", {
      visits: [
        visit({
          board: "build",
          exitedAt: "2026-08-20T11:00:00.000Z",
          exit: "sent-on",
          next: "review",
          handoffNote: "kernel gate done",
          claimedBy: `seat_${"1".repeat(64)}` as ActorSeatId,
        }),
        visit({ board: "review", enteredAt: "2026-08-20T11:00:00.000Z" }),
      ],
    });
    const board = doc([
      sink("build", [buildRow], [
        { id: "c1", text: "types clean" },
        { id: "c2", text: "screenshots attached" },
      ]),
      sink("review", [current], [{ id: "c3", text: "read the diff" }]),
    ]);

    const view = buildTaskVisits(board, current, "review");
    expect(view.layers.length).toBe(2);
    expect(view.boardCount).toBe(2);

    const first = view.layers[0]!;
    expect(first.board).toBe("build");
    expect(first.live).toBe(false);
    expect(first.handoffNote).toBe("kernel gate done");
    expect(first.refs).toEqual(["src/a.ts"]);
    expect(first.receipts.map((r) => [r.ruleId, r.kind, r.ruleText])).toEqual([
      ["c1", "claim", "types clean"],
      ["c2", "waiver", "screenshots attached"],
    ]);
    expect(first.checks.map((t) => [t.checkId, t.green])).toEqual([
      ["k1", true],
      ["k2", false],
    ]);
    expect(layerExitLabel(first)).toBe("Sent on to review");

    const second = view.layers[1]!;
    expect(second.live).toBe(true);
    expect(second.receipts).toEqual([]);
    expect(second.openRules.map((c) => c.text)).toEqual(["read the diff"]);
    expect(layerExitLabel(second)).toBe("Here now");
  });

  it("keeps upstream claims live and marks only the defect target onward for rework", () => {
    const defectNote = makeAgentMessage({
      messageId: "m2",
      text: 'defect from "review": missing receipts\nref: src/b.ts',
      contextId: "c1",
      taskId: "t1",
    });
    const upstream = task("shape", {
      state: "completed",
      completionEvidence: {
        artifacts: [],
        claims: [{ ruleId: "c-shape", text: "foundation stayed square" }],
      },
    });
    const downstream = task("wire", {
      state: "completed",
      completionEvidence: {
        artifacts: [],
        claims: [{ ruleId: "c-wire", text: "continuity checked" }],
      },
    });
    const current = task("build", {
      epoch: 1,
      defects: [{ epoch: 1, target: "build", at: "2026-08-20T12:00:00.000Z" }],
      history: [brief, defectNote],
      visits: [
        visit({ board: "shape", exit: "sent-on", next: "build" }),
        visit({ board: "build", exit: "sent-on", next: "wire" }),
        visit({ board: "wire", exit: "sent-on", next: "review" }),
        visit({
          board: "review",
          exit: "sent-back",
          next: "build",
          exitedAt: "2026-08-20T12:00:00.000Z",
        }),
        visit({ board: "build", epoch: 1, enteredAt: "2026-08-20T12:00:00.000Z" }),
      ],
    });
    const board = doc([
      sink("shape", [upstream], [{ id: "c-shape", text: "base is square" }]),
      sink("build", [current]),
      sink("wire", [downstream], [{ id: "c-wire", text: "wiring is continuous" }]),
      sink("review", []),
    ]);

    const view = buildTaskVisits(board, current, "build");
    expect(view.epoch).toBe(1);
    expect(view.layers.map((layer) => layer.needsRedo)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    expect(view.layers.map((layer) => layer.receiptState)).toEqual([
      "live",
      undefined,
      "superseded",
      undefined,
      undefined,
    ]);
    expect(view.layers.map((layer) => layer.epochStart)).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(view.layers[3]!.defect).toEqual({
      summary: "missing receipts",
      refs: ["src/b.ts"],
      target: "build",
      targetBoard: "build",
    });
    expect(view.layers[3]!.refs).toEqual(["src/b.ts"]);
    expect(layerExitLabel(view.layers[3]!)).toBe("Sent back to build");
    expect(view.layers[4]!.epochDefect).toEqual({
      target: "build",
      targetBoard: "build",
    });
    expect(view.layers[4]!.live).toBe(true);
  });
});
