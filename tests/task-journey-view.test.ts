import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { Passage, Task, Ticket } from "../src/shared/work-model";
import type { ActorSeatId } from "../src/shared/actor-seat";
import { makeAgentMessage } from "../src/shared/task";
import {
  buildTaskJourney,
  layerExitLabel,
} from "../src/renderer/components/work/task-journey";

const brief = makeAgentMessage({
  messageId: "m1",
  text: "ship the pipeline view",
  contextId: "c1",
  taskId: "t1",
});

const task = (nodeId: string, overrides: Partial<Task> = {}): Task => ({
  id: "t1",
  state: "working",
  history: [brief],
  ...overrides,
});

const sink = (id: string, items: ReadonlyArray<Task>, claims?: ReadonlyArray<{
  readonly id: string;
  readonly text: string;
  readonly severity: "hard" | "soft";
}>): CanvasNode => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ether: {
    entity: { kind: "task", name: `${id} station` },
    tasks: {
      items: [...items],
      ...(claims !== undefined ? { contract: { claims: [...claims] } } : {}),
    },
  },
});

const doc = (nodes: ReadonlyArray<CanvasNode>): CanvasDoc => ({
  nodes: [...nodes],
  edges: [],
});

const passage = (over: Partial<Passage> & Pick<Passage, "nodeId">): Passage => ({
  enteredAt: "2026-08-20T10:00:00.000Z",
  epoch: 0,
  ...over,
});

const ticket = (over: Partial<Ticket> & Pick<Ticket, "checkId">): Ticket => ({
  side: "outbound",
  label: "typecheck",
  command: "bun run typecheck",
  exitCode: 0,
  outputTail: "",
  at: "2026-08-20T10:30:00.000Z",
  epoch: 0,
  ...over,
});

describe("buildTaskJourney", () => {
  it("returns no layers for a task that never travelled", () => {
    const board = doc([sink("build", [task("build")])]);
    expect(buildTaskJourney(board, task("build"), "build").layers).toEqual([]);
  });

  it("joins each passage to the receipts and tickets left on its station row", () => {
    const buildRow = task("build", {
      state: "completed",
      completionEvidence: {
        artifacts: [],
        responses: [{ claimId: "c1", response: "typechecked", refs: ["src/a.ts"] }],
        claimWaivers: [{ claimId: "c2", reason: "no ui surface touched" }],
      },
      boarding: [ticket({ checkId: "k1" }), ticket({ checkId: "k2", exitCode: 1 })],
    });
    const current = task("review", {
      journey: [
        passage({
          nodeId: "build",
          exitedAt: "2026-08-20T11:00:00.000Z",
          exit: "forwarded",
          next: "review",
          emissionNote: "kernel gate done",
          claimedBy: `seat_${"1".repeat(64)}` as ActorSeatId,
        }),
        passage({ nodeId: "review", enteredAt: "2026-08-20T11:00:00.000Z" }),
      ],
    });
    const board = doc([
      sink("build", [buildRow], [
        { id: "c1", text: "types clean", severity: "hard" },
        { id: "c2", text: "screenshots attached", severity: "soft" },
      ]),
      sink("review", [current], [{ id: "c3", text: "read the diff", severity: "hard" }]),
    ]);

    const view = buildTaskJourney(board, current, "review");
    expect(view.layers.length).toBe(2);
    expect(view.stationCount).toBe(2);

    const first = view.layers[0]!;
    expect(first.station).toBe("build station");
    expect(first.live).toBe(false);
    expect(first.emissionNote).toBe("kernel gate done");
    expect(first.refs).toEqual(["src/a.ts"]);
    expect(first.receipts.map((r) => [r.claimId, r.kind, r.claimText, r.severity])).toEqual([
      ["c1", "response", "types clean", "hard"],
      ["c2", "waiver", "screenshots attached", "soft"],
    ]);
    expect(first.tickets.map((t) => [t.checkId, t.green])).toEqual([
      ["k1", true],
      ["k2", false],
    ]);
    expect(layerExitLabel(first)).toBe("Forwarded to review station");

    const second = view.layers[1]!;
    expect(second.live).toBe(true);
    expect(second.receipts).toEqual([]);
    expect(second.openClaims.map((c) => c.text)).toEqual(["read the diff"]);
    expect(layerExitLabel(second)).toBe("Here now");
  });

  it("marks prior-epoch layers stale and opens an epoch boundary at the send-back", () => {
    const defectNote = makeAgentMessage({
      messageId: "m2",
      text: 'defect from "review": missing receipts\nref: src/b.ts',
      contextId: "c1",
      taskId: "t1",
    });
    const current = task("build", {
      epoch: 1,
      history: [brief, defectNote],
      journey: [
        passage({ nodeId: "build", exit: "forwarded", next: "review" }),
        passage({
          nodeId: "review",
          exit: "rejected-back",
          next: "build",
          exitedAt: "2026-08-20T12:00:00.000Z",
        }),
        passage({ nodeId: "build", epoch: 1, enteredAt: "2026-08-20T12:00:00.000Z" }),
      ],
    });
    const board = doc([sink("build", [current]), sink("review", [])]);

    const view = buildTaskJourney(board, current, "build");
    expect(view.epoch).toBe(1);
    expect(view.layers.map((l) => l.stale)).toEqual([true, true, false]);
    expect(view.layers.map((l) => l.epochStart)).toEqual([true, false, true]);
    expect(view.layers[1]!.defect).toEqual({
      summary: "missing receipts",
      refs: ["src/b.ts"],
    });
    expect(view.layers[1]!.refs).toEqual(["src/b.ts"]);
    expect(layerExitLabel(view.layers[1]!)).toBe("Sent back to build station");
    expect(view.layers[2]!.live).toBe(true);
  });
});
