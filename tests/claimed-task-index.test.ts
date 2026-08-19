import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { TaskState } from "../src/shared/work-model";
import { ActorRef } from "../src/shared/work-protocol";
import { claimedTaskForActorNode } from "../src/renderer/lib/claimed-task";
import {
  buildClaimedTaskIndex,
  claimedTask$,
  startClaimedTaskIndex,
  stopClaimedTaskIndex,
} from "../src/renderer/lib/claimed-task-index";
import { state$, EMPTY_DOC } from "../src/renderer/lib/state";

const seatId = (n: number): string => `seat_${String(n).repeat(64).slice(0, 64)}`;

const actor = (n: number) =>
  Schema.decodeUnknownSync(ActorRef)({
    seatId: seatId(n),
    canvasName: "factory",
    nodeId: `agent-${n}`,
  });

const taskNode = (
  id: string,
  tasks: ReadonlyArray<{
    readonly id: string;
    readonly state: TaskState;
    readonly claimedBy?: string;
    readonly brief?: string;
  }>,
): CanvasNode =>
  ({
    id,
    type: "text",
    text: "tasks",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    ether: {
      entity: { kind: "task" },
      tasks: {
        items: tasks.map((task) => ({
          id: task.id,
          state: task.state,
          ...(task.claimedBy ? { claimedBy: task.claimedBy } : {}),
          history: [
            {
              messageId: `${task.id}-brief`,
              role: "user" as const,
              parts: [{ kind: "text" as const, text: task.brief ?? task.id }],
              taskId: task.id,
            },
          ],
        })),
      },
    },
  }) as CanvasNode;

/** A note whose text a rename box would rewrite on every keystroke. */
const noteNode = (text: string): CanvasNode =>
  ({ id: "note", type: "text", text, x: 0, y: 0, width: 200, height: 100 }) as CanvasNode;

const docWith = (
  noteText: string,
  tasks: ReadonlyArray<{
    readonly id: string;
    readonly state: TaskState;
    readonly claimedBy?: string;
    readonly brief?: string;
  }>,
): CanvasDoc => ({
  nodes: [noteNode(noteText), taskNode("tasks", tasks)],
  edges: [],
});

const actors = [actor(1), actor(2), actor(3)];

const workingDoc = (noteText: string): CanvasDoc =>
  docWith(noteText, [
    { id: "task-1", state: "working", claimedBy: seatId(1), brief: "ship the strip" },
    { id: "task-2", state: "working", claimedBy: seatId(2), brief: "wire the index" },
    { id: "task-3", state: "submitted" },
  ]);

/** Count notifications per seat key — one notification is one strip re-render. */
const watchStrips = (nodeIds: ReadonlyArray<string>) => {
  const counts = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const offs = nodeIds.map((id) =>
    claimedTask$.byNodeId[id].onChange(() => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }),
  );
  return {
    counts,
    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
    stop: () => offs.forEach((off) => off()),
  };
};

describe("claimed task index", () => {
  beforeEach(() => {
    stopClaimedTaskIndex();
    claimedTask$.byNodeId.set({});
    state$.doc.set(EMPTY_DOC);
    state$.actorRefs.set([]);
    startClaimedTaskIndex();
  });

  afterEach(() => {
    stopClaimedTaskIndex();
    claimedTask$.byNodeId.set({});
    state$.doc.set(EMPTY_DOC);
    state$.actorRefs.set([]);
  });

  it("answers exactly what the per-node scan answers", () => {
    const doc = workingDoc("note");
    const index = buildClaimedTaskIndex(doc, actors);
    for (const seat of actors) {
      expect(index[seat.nodeId]).toEqual(
        claimedTaskForActorNode(doc, actors, seat.nodeId),
      );
    }
    expect(index["agent-3"]).toBeUndefined();
  });

  it("publishes one entry per claimed seat and nothing for an unclaimed seat", () => {
    state$.actorRefs.set(actors);
    state$.doc.set(workingDoc("note"));

    expect(claimedTask$.byNodeId["agent-1"].peek()).toMatchObject({
      sinkNodeId: "tasks",
      task: { id: "task-1", state: "working" },
    });
    // Absent stays absent — the strip renders null, never an empty row.
    expect(claimedTask$.byNodeId["agent-3"].peek()).toBeUndefined();
    expect(Object.keys(claimedTask$.byNodeId.peek())).toEqual([
      "agent-1",
      "agent-2",
    ]);
  });

  it("does not touch any seat key on a document write unrelated to claims", () => {
    state$.actorRefs.set(actors);
    state$.doc.set(workingDoc("note"));

    const watch = watchStrips(["agent-1", "agent-2", "agent-3"]);
    // A rename box replaces the document identity on every keystroke.
    for (const keystroke of ["n", "na", "nam", "name"]) {
      state$.doc.set(workingDoc(keystroke));
    }
    watch.stop();

    expect(watch.total()).toBe(0);
  });

  it("keeps each published entry's identity across unrelated document writes", () => {
    state$.actorRefs.set(actors);
    state$.doc.set(workingDoc("note"));
    const before = claimedTask$.byNodeId["agent-1"].peek();

    for (const keystroke of ["n", "na", "nam", "name"]) {
      state$.doc.set(workingDoc(keystroke));
    }

    // The publish gate skipped the write entirely, so the seat still holds the
    // object it was already serving — no re-store, no deep re-compare of the
    // whole task on a keystroke that never touched a claim.
    expect(claimedTask$.byNodeId["agent-1"].peek()).toBe(before);
  });

  it("wakes only the seat whose claim moved", () => {
    state$.actorRefs.set(actors);
    state$.doc.set(workingDoc("note"));

    const watch = watchStrips(["agent-1", "agent-2", "agent-3"]);
    state$.doc.set(
      docWith("note", [
        { id: "task-1", state: "working", claimedBy: seatId(1), brief: "ship the strip" },
        { id: "task-2", state: "input-required", claimedBy: seatId(2), brief: "wire the index" },
        { id: "task-3", state: "submitted" },
      ]),
    );
    watch.stop();

    expect(watch.counts.get("agent-2")).toBe(1);
    expect(watch.counts.get("agent-1")).toBe(0);
    expect(watch.counts.get("agent-3")).toBe(0);
    expect(claimedTask$.byNodeId["agent-2"].peek()).toMatchObject({
      task: { id: "task-2", state: "input-required" },
    });
  });

  it("drops a seat's entry when its claim closes, and re-adds it on a new claim", () => {
    state$.actorRefs.set(actors);
    state$.doc.set(workingDoc("note"));

    state$.doc.set(
      docWith("note", [
        { id: "task-1", state: "completed", claimedBy: seatId(1), brief: "ship the strip" },
        { id: "task-2", state: "working", claimedBy: seatId(2), brief: "wire the index" },
      ]),
    );
    expect(claimedTask$.byNodeId["agent-1"].peek()).toBeUndefined();

    state$.doc.set(
      docWith("note", [
        { id: "task-4", state: "working", claimedBy: seatId(1), brief: "next one" },
        { id: "task-2", state: "working", claimedBy: seatId(2), brief: "wire the index" },
      ]),
    );
    expect(claimedTask$.byNodeId["agent-1"].peek()).toMatchObject({
      task: { id: "task-4", state: "working" },
    });
  });

  it("republishes when the compiled seat projection changes under a stable document", () => {
    state$.doc.set(workingDoc("note"));
    expect(claimedTask$.byNodeId["agent-1"].peek()).toBeUndefined();

    state$.actorRefs.set(actors);
    expect(claimedTask$.byNodeId["agent-1"].peek()).toMatchObject({
      task: { id: "task-1" },
    });

    state$.actorRefs.set([]);
    expect(claimedTask$.byNodeId["agent-1"].peek()).toBeUndefined();
  });

  it("serves the new brief when only the brief text changed", () => {
    state$.actorRefs.set(actors);
    state$.doc.set(workingDoc("note"));

    const watch = watchStrips(["agent-1"]);
    state$.doc.set(
      docWith("note", [
        { id: "task-1", state: "working", claimedBy: seatId(1), brief: "renamed brief" },
        { id: "task-2", state: "working", claimedBy: seatId(2), brief: "wire the index" },
      ]),
    );
    watch.stop();

    expect(watch.counts.get("agent-1")).toBe(1);
    expect(claimedTask$.byNodeId["agent-1"].peek()?.task.history[0]?.parts[0]).toMatchObject({
      text: "renamed brief",
    });
  });
});
