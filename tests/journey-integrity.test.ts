import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { Task } from "../src/shared/work-model";
import {
  defectTargetOptions,
  flowEdgeRemovalImpact,
  stationDeletionImpact,
  stationsReferencedByLiveJourneys,
} from "../src/shared/journey-integrity";

const sink = (id: string, items: ReadonlyArray<Task> = []): CanvasNode => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  ether: { entity: { kind: "task" }, tasks: { items: [...items] } },
});

const flowEdge = (id: string, source: string, destination: string) => ({
  id,
  fromNode: source,
  toNode: destination,
  ether: { flow: { source, destination } },
});

const task = (id: string, overrides: Partial<Task> = {}): Task =>
  ({
    id,
    state: "working",
    history: [
      {
        messageId: `msg-${id}`,
        role: "user",
        parts: [{ kind: "text", text: "work" }],
      },
    ],
    ...overrides,
  }) as Task;

const journeyed = (id: string, overrides: Partial<Task> = {}): Task =>
  task(id, {
    epoch: 1,
    journey: [
      { nodeId: "s1", enteredAt: "2026-08-20T00:00:00.000Z", epoch: 0, exit: "forwarded", next: "s2" },
      { nodeId: "s2", enteredAt: "2026-08-20T01:00:00.000Z", epoch: 0, exit: "rejected-back", next: "s1" },
      { nodeId: "s1", enteredAt: "2026-08-20T02:00:00.000Z", epoch: 1 },
    ],
    defects: [{ epoch: 1, target: "s1", at: "2026-08-20T01:30:00.000Z" }],
    ...overrides,
  });

describe("stationsReferencedByLiveJourneys", () => {
  it("maps passages, defect targets, and the live row home", () => {
    const doc: CanvasDoc = {
      nodes: [sink("s1", [journeyed("t1")]), sink("s2")],
      edges: [flowEdge("e1", "s1", "s2")],
    };
    const refs = stationsReferencedByLiveJourneys(doc);
    const kindsAt = (station: string) =>
      (refs.get(station) ?? []).map((entry) => entry.kind).sort();
    expect(kindsAt("s1")).toEqual(["defect-target", "home-row", "passage"]);
    expect(kindsAt("s2")).toEqual(["passage"]);
  });

  it("ignores terminal tasks entirely", () => {
    const doc: CanvasDoc = {
      nodes: [sink("s1", [journeyed("t1", { state: "completed" })]), sink("s2")],
      edges: [],
    };
    expect(stationsReferencedByLiveJourneys(doc).size).toBe(0);
  });
});

describe("stationDeletionImpact", () => {
  const doc: CanvasDoc = {
    nodes: [sink("s1", [journeyed("t1")]), sink("s2")],
    edges: [],
  };

  it("names stranded live tasks and whether live rows vanish", () => {
    const impact = stationDeletionImpact(doc, "s1");
    expect(impact.carriesLiveRows).toBe(true);
    expect(impact.strandedTasks).toEqual([
      { taskId: "t1", kinds: expect.arrayContaining(["passage", "defect-target", "home-row"]) },
    ]);

    const passageOnly = stationDeletionImpact(doc, "s2");
    expect(passageOnly.carriesLiveRows).toBe(false);
    expect(passageOnly.strandedTasks).toEqual([
      { taskId: "t1", kinds: ["passage"] },
    ]);
  });

  it("is empty for an unreferenced station", () => {
    const impact = stationDeletionImpact(
      { nodes: [...doc.nodes, sink("s9")], edges: [] },
      "s9",
    );
    expect(impact.strandedTasks).toEqual([]);
    expect(impact.carriesLiveRows).toBe(false);
  });
});

describe("flowEdgeRemovalImpact", () => {
  it("names live tasks at the source and flags the last destination", () => {
    const doc: CanvasDoc = {
      nodes: [sink("s1", [task("t1"), task("t2", { state: "completed" })]), sink("s2")],
      edges: [flowEdge("e1", "s1", "s2")],
    };
    const impact = flowEdgeRemovalImpact(doc, "s1", "s2");
    expect(impact.affectedTasks).toEqual(["t1"]);
    expect(impact.lastDestination).toBe(true);
  });

  it("keeps lastDestination false while another destination remains", () => {
    const doc: CanvasDoc = {
      nodes: [sink("s1", [task("t1")]), sink("s2"), sink("s3")],
      edges: [flowEdge("e1", "s1", "s2"), flowEdge("e2", "s1", "s3")],
    };
    expect(flowEdgeRemovalImpact(doc, "s1", "s2").lastDestination).toBe(false);
  });
});

describe("defectTargetOptions", () => {
  it("lists visited stations except the current one, flagging absentees", () => {
    const doc: CanvasDoc = {
      nodes: [sink("s1"), sink("s3", [])],
      edges: [],
    };
    const traveled = task("t1", {
      journey: [
        { nodeId: "s1", enteredAt: "2026-08-20T00:00:00.000Z", epoch: 0, exit: "forwarded", next: "s2" },
        { nodeId: "s2", enteredAt: "2026-08-20T01:00:00.000Z", epoch: 0, exit: "forwarded", next: "s3" },
        { nodeId: "s3", enteredAt: "2026-08-20T02:00:00.000Z", epoch: 0 },
      ],
    });
    expect(defectTargetOptions(doc, traveled, "s3")).toEqual([
      { station: "s1", present: true },
      { station: "s2", present: false },
    ]);
  });
});
