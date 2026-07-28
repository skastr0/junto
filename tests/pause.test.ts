import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { PAUSED_CANVAS, regionsContaining, seatPaused } from "../src/shared/pause";
import { selectFactoryClaims } from "../src/shared/factory-tick";
import { taskItem } from "./helpers/task-fixtures";
import { seat } from "./helpers/physics-seats";
import { actorRefFixture } from "./helpers/actor-ref-fixtures";

const doc: CanvasDoc = {
  nodes: [
    { id: "r1", type: "group", x: 0, y: 0, width: 500, height: 300 },
    { ...seat("a1", "actor"), x: 20, y: 20 },
    { ...seat("a2", "actor"), x: 900, y: 900 },
  ],
  edges: [],
};

describe("pause law", () => {
  it("a canvas with no play decision is paused — born paused", () => {
    expect(PAUSED_CANVAS.playing).toBe(false);
    expect(PAUSED_CANVAS.everPlayed).toBe(false);
    expect(seatPaused(PAUSED_CANVAS, doc, "a1")).toBe(true);
  });

  it("playing canvas: node and containing-region pauses still hold", () => {
    const playing = { ...PAUSED_CANVAS, playing: true };
    expect(seatPaused(playing, doc, "a1")).toBe(false);

    expect(seatPaused({ ...playing, pausedNodes: ["a1"] }, doc, "a1")).toBe(true);
    expect(seatPaused({ ...playing, pausedNodes: ["a1"] }, doc, "a2")).toBe(false);

    // a1 sits inside region r1 (center containment); a2 is outside it.
    expect(regionsContaining(doc, "a1")).toContain("r1");
    expect(seatPaused({ ...playing, pausedRegions: ["r1"] }, doc, "a1")).toBe(true);
    expect(seatPaused({ ...playing, pausedRegions: ["r1"] }, doc, "a2")).toBe(false);
  });
});

describe("claim tick under pause", () => {
  const board = (): CanvasDoc => ({
    nodes: [
      {
        id: "t",
        type: "text",
        text: "tasks",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        ether: { entity: { kind: "task" }, tasks: { items: [taskItem("i1", "ship", "submitted")] } },
      },
      seat("w1", "actor"),
    ],
    edges: [{ id: "e1", fromNode: "t", toNode: "w1" }],
  });

  it("a paused worker never claims; a paused sink never drains", () => {
    const worker = actorRefFixture("w1");
    const resolveActorRef = (ref: {
      readonly canvasName: string;
      readonly nodeId: string;
    }) =>
      ref.canvasName === worker.canvasName && ref.nodeId === worker.nodeId
        ? worker
        : undefined;
    const free = selectFactoryClaims(board(), "c", resolveActorRef);
    expect(free).toEqual([
      {
        sink: { canvasName: "c", nodeId: "t" },
        task: {
          kind: "task",
          itemId: "i1",
          sink: { canvasName: "c", nodeId: "t" },
        },
        actor: worker,
      },
    ]);

    const pausedWorker = selectFactoryClaims(
      board(),
      "c",
      resolveActorRef,
      {
        seatPaused: (id) => id === "w1",
      },
    );
    expect(pausedWorker).toEqual([]);

    const pausedSink = selectFactoryClaims(
      board(),
      "c",
      resolveActorRef,
      {
        seatPaused: (id) => id === "t",
      },
    );
    expect(pausedSink).toEqual([]);
  });
});
