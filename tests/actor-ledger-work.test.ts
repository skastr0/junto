import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  artifactRowsForSeat,
  boardRowsForActor,
  claimedTaskRow,
  raisedTaskRowsForSeat,
  requestRowsForSeat,
  seatIdForActorNode,
} from "../src/renderer/lib/actor-ledger-work";
import { ActorRef } from "../src/shared/work-protocol";
import type { CanvasDoc, TextNode } from "../src/shared/canvas";
import type { Message, Task } from "../src/shared/work-model";

const actor = Schema.decodeUnknownSync(ActorRef)({
  seatId: `seat_${"a".repeat(64)}`,
  canvasName: "factory",
  nodeId: "agent",
});

const otherActor = Schema.decodeUnknownSync(ActorRef)({
  seatId: `seat_${"b".repeat(64)}`,
  canvasName: "factory",
  nodeId: "other-agent",
});

const brief = (messageId: string, text: string): Message => ({
  messageId,
  role: "agent",
  parts: [{ kind: "text", text }],
});

const sinkNode = (
  id: string,
  ether: TextNode["ether"],
): TextNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether,
});

const docOf = (nodes: readonly TextNode[]): CanvasDoc => ({
  nodes: [...nodes],
  edges: [],
});

const emptyDoc: CanvasDoc = docOf([
  sinkNode("bare", { entity: { kind: "task" } }),
]);

describe("seatIdForActorNode", () => {
  it("resolves the compiled seat for an actor node", () => {
    expect(seatIdForActorNode([actor, otherActor], "agent")).toBe(actor.seatId);
    expect(seatIdForActorNode([actor], "nope")).toBeUndefined();
    expect(seatIdForActorNode([], "agent")).toBeUndefined();
  });
});

describe("claimedTaskRow", () => {
  const claimDoc = (state: "working" | "input-required"): CanvasDoc =>
    docOf([
      sinkNode("tasks", {
        entity: { kind: "task" },
        tasks: {
          items: [
            {
              id: "task-1",
              state,
              claimedBy: actor.seatId,
              history: [brief("m1", "Ship the ledger pane\nwith details")],
            } as Task,
          ],
        },
      }),
    ]);

  it("projects the working claim with the brief first line as title", () => {
    expect(claimedTaskRow(claimDoc("working"), [actor], "agent")).toEqual({
      taskId: "task-1",
      sinkNodeId: "tasks",
      state: "working",
      title: "Ship the ledger pane",
      needsInput: false,
    });
  });

  it("flags input-required claims as needing input", () => {
    expect(
      claimedTaskRow(claimDoc("input-required"), [actor], "agent"),
    ).toMatchObject({ state: "input-required", needsInput: true });
  });

  it("falls back to Untitled task when the brief has no text", () => {
    const doc = docOf([
      sinkNode("tasks", {
        entity: { kind: "task" },
        tasks: {
          items: [
            {
              id: "task-2",
              state: "working",
              claimedBy: actor.seatId,
              history: [],
            } as Task,
          ],
        },
      }),
    ]);
    expect(claimedTaskRow(doc, [actor], "agent")).toMatchObject({
      title: "Untitled task",
    });
  });

  it("is undefined for unknown nodes and empty docs", () => {
    expect(claimedTaskRow(emptyDoc, [actor], "agent")).toBeUndefined();
    expect(claimedTaskRow(claimDoc("working"), [actor], "nope")).toBeUndefined();
  });
});

describe("raisedTaskRowsForSeat", () => {
  const task = (
    id: string,
    state: Task["state"],
    by: typeof actor,
    text: string,
    extra?: Partial<Task>,
  ): Task =>
    ({
      id,
      state,
      history: [brief(`m-${id}`, text)],
      raisedBy: { kind: "seat", seatId: by.seatId, nodeId: by.nodeId },
      ...extra,
    }) as Task;

  const doc = docOf([
    sinkNode("tasks-a", {
      entity: { kind: "task" },
      tasks: {
        items: [
          task("01A", "canceled", actor, "Oldest canceled", { reason: "risky" }),
          task("01C", "submitted", actor, "Newer waiting", { admission: "approval" }),
          task("01D", "submitted", otherActor, "Someone else's"),
        ],
      },
    }),
    sinkNode("tasks-b", {
      entity: { kind: "task" },
      tasks: {
        items: [
          task("01B", "working", actor, "Working one"),
          task("01E", "submitted", actor, "Newest waiting", { admission: "approval" }),
        ],
      },
    }),
  ]);

  it("filters by raiser seat and sorts awaiting approval first, newest first", () => {
    const rows = raisedTaskRowsForSeat(doc, actor.seatId);
    expect(rows.map((row) => row.taskId)).toEqual(["01E", "01C", "01B", "01A"]);
    expect(rows[0]).toEqual({
      taskId: "01E",
      sinkNodeId: "tasks-b",
      state: "submitted",
      title: "Newest waiting",
      awaitingApproval: true,
      dependsOnCount: 0,
      hasFinishCriteria: false,
    });
    expect(rows[3]).toMatchObject({ state: "canceled", reason: "risky" });
  });

  it("falls back to Untitled task when the brief has no text", () => {
    const bare = docOf([
      sinkNode("tasks", {
        entity: { kind: "task" },
        tasks: {
          items: [
            {
              id: "01F",
              state: "submitted",
              history: [{ messageId: "m-01F", role: "agent", parts: [] }],
              raisedBy: { kind: "seat", seatId: actor.seatId, nodeId: actor.nodeId },
            } as unknown as Task,
          ],
        },
      }),
    ]);
    expect(raisedTaskRowsForSeat(bare, actor.seatId)).toEqual([
      {
        taskId: "01F",
        sinkNodeId: "tasks",
        state: "submitted",
        title: "Untitled task",
        awaitingApproval: false,
        dependsOnCount: 0,
        hasFinishCriteria: false,
      },
    ]);
  });

  it("is empty for docs without tasks items", () => {
    expect(raisedTaskRowsForSeat(emptyDoc, actor.seatId)).toEqual([]);
    expect(raisedTaskRowsForSeat(docOf([]), actor.seatId)).toEqual([]);
  });
});

describe("requestRowsForSeat", () => {
  const request = (
    id: string,
    state: Task["state"],
    extra?: Partial<Task>,
  ): Task =>
    ({
      id,
      state,
      claimedBy: actor.seatId,
      history: [brief(`m-${id}`, `Request ${id} body`)],
      ...extra,
    }) as Task;

  const doc = docOf([
    sinkNode("requests-a", {
      entity: { kind: "request" },
      requests: {
        items: [
          request("01A", "completed", {
            response: "Approved, go ahead",
            metadata: { title: "Access to prod " },
          }),
          request("01C", "input-required"),
          request("01D", "input-required", { claimedBy: otherActor.seatId }),
        ],
      },
    }),
    sinkNode("requests-b", {
      entity: { kind: "request" },
      requests: {
        items: [request("01B", "input-required")],
      },
    }),
  ]);

  it("filters by raiser claimedBy, includes resolved ones, sorts attention first", () => {
    const rows = requestRowsForSeat(doc, actor.seatId);
    expect(rows.map((row) => row.requestId)).toEqual(["01C", "01B", "01A"]);
    expect(rows[0]).toEqual({
      requestId: "01C",
      sinkNodeId: "requests-a",
      state: "input-required",
      title: "Request 01C body",
      needsInput: true,
      attention: true,
    });
    expect(rows[2]).toEqual({
      requestId: "01A",
      sinkNodeId: "requests-a",
      state: "completed",
      title: "Access to prod",
      needsInput: false,
      attention: false,
      response: "Approved, go ahead",
      details: "Request 01A body",
    });
  });

  it("counts residual auth-required as attention but never as answerable", () => {
    const authDoc = docOf([
      sinkNode("requests", {
        entity: { kind: "request" },
        requests: {
          items: [request("01F", "auth-required"), request("01G", "completed")],
        },
      }),
    ]);
    const rows = requestRowsForSeat(authDoc, actor.seatId);
    expect(rows.map((row) => row.requestId)).toEqual(["01F", "01G"]);
    expect(rows[0].attention).toBe(true);
    expect(rows[0].needsInput).toBe(false);
  });

  it("falls back to Untitled request when there is no title anywhere", () => {
    const bare = docOf([
      sinkNode("requests", {
        entity: { kind: "request" },
        requests: {
          items: [request("01E", "input-required", { history: [] })],
        },
      }),
    ]);
    expect(requestRowsForSeat(bare, actor.seatId)).toEqual([
      {
        requestId: "01E",
        sinkNodeId: "requests",
        state: "input-required",
        title: "Untitled request",
        needsInput: true,
        attention: true,
      },
    ]);
  });

  it("is empty for docs without request containers", () => {
    expect(requestRowsForSeat(emptyDoc, actor.seatId)).toEqual([]);
    expect(requestRowsForSeat(docOf([]), actor.seatId)).toEqual([]);
  });
});

describe("artifactRowsForSeat", () => {
  const artifact = (
    artifactId: string,
    metadata: Record<string, unknown> | undefined,
    parts: ReadonlyArray<{ readonly kind: "text"; readonly text: string }> = [
      { kind: "text", text: "body" },
    ],
    name?: string,
  ) => ({
    artifactId,
    parts,
    ...(name !== undefined ? { name } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });

  it("keeps only this seat's live artifacts, newest first", () => {
    const doc = docOf([
      sinkNode("shelf", {
        entity: { kind: "artifacts" },
        artifacts: {
          items: [
            artifact("01A", { publishedBySeatId: actor.seatId }, undefined, "older"),
            artifact("01B", { publishedBySeatId: otherActor.seatId }, undefined, "foreign"),
            artifact("01C", { publishedBySeatId: actor.seatId }, undefined, "newer"),
            artifact("01D", { publishedBySeatId: actor.seatId, archived: true }, undefined, "hidden"),
            artifact("01E", undefined, undefined, "unstamped"),
          ],
        },
      }),
    ]);
    const rows = artifactRowsForSeat(doc, actor.seatId);
    expect(rows.map((row) => row.name)).toEqual(["newer", "older"]);
    expect(rows[0]).toMatchObject({
      artifactId: "01C",
      sinkNodeId: "shelf",
      partCount: 1,
      textPreview: "body",
      archived: false,
    });
  });

  it("falls back to the artifact id for the name and handles textless parts", () => {
    const doc = docOf([
      sinkNode("shelf", {
        entity: { kind: "artifacts" },
        artifacts: {
          items: [
            {
              artifactId: "01F",
              parts: [{ kind: "url", url: "https://example.com/x.png" }],
              metadata: { publishedBySeatId: actor.seatId },
            },
          ],
        },
      }),
    ]);
    const rows = artifactRowsForSeat(doc, actor.seatId);
    expect(rows[0]).toMatchObject({ name: "01F", textPreview: undefined });
  });

  it("is empty without artifact containers", () => {
    expect(artifactRowsForSeat(emptyDoc, actor.seatId)).toEqual([]);
  });
});

describe("boardRowsForActor", () => {
  const glanceTopic = (
    topicId: string,
    title: string,
    state: "open" | "archived",
    postCount: number,
    lastActivityAt: string,
    authorLabel?: string,
  ) => ({
    topicId,
    title,
    state,
    postCount,
    lastActivityAt,
    ...(authorLabel !== undefined ? { authorLabel } : {}),
  });

  const boardDoc: CanvasDoc = {
    nodes: [
      sinkNode("agent-node", { entity: { kind: "agent", name: "local:a" } }),
      sinkNode("wired-board", {
        entity: { kind: "board" },
        board: {
          topics: [
            glanceTopic("t-old", "Older open", "open", 3, "2026-08-01T10:00:00.000Z"),
            glanceTopic("t-arch", "Archived", "archived", 9, "2026-08-12T10:00:00.000Z", "operator"),
            glanceTopic("t-new", "Newer open", "open", 1, "2026-08-10T10:00:00.000Z"),
          ],
          unread: 2,
        },
      }),
      sinkNode("stranger-board", {
        entity: { kind: "board" },
        board: { topics: [glanceTopic("t-x", "Unwired", "open", 1, "2026-08-11T00:00:00.000Z")] },
      }),
    ],
    edges: [
      { id: "e1", fromNode: "wired-board", toNode: "agent-node" },
    ],
  };

  it("keeps only wired boards, open topics first then latest activity", () => {
    const rows = boardRowsForActor(boardDoc, "agent-node");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unread).toBe(2);
    expect(rows[0]!.topics.map((t) => t.topicId)).toEqual([
      "t-new",
      "t-old",
      "t-arch",
    ]);
    expect(rows[0]!.topics[2]).toMatchObject({
      open: false,
      authorLabel: "operator",
      postCount: 9,
    });
  });

  it("parses activity timestamps defensively", () => {
    const doc: CanvasDoc = {
      nodes: [
        sinkNode("agent-node", { entity: { kind: "agent", name: "local:a" } }),
        sinkNode("b", {
          entity: { kind: "board" },
          board: { topics: [glanceTopic("t", "Bad clock", "open", 1, "not-a-date")] },
        }),
      ],
      edges: [{ id: "e", fromNode: "agent-node", toNode: "b" }],
    };
    expect(boardRowsForActor(doc, "agent-node")[0]!.topics[0]!.lastActivityAtMs).toBeUndefined();
  });

  it("is empty without wired boards", () => {
    expect(boardRowsForActor(emptyDoc, "agent-node")).toEqual([]);
  });
});
