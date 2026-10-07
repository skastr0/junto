import { describe, expect, it } from "vitest";
import { workMessageAppend, type WorkPolicyRead } from "../src/shared/work";
import type { CanvasDoc } from "../src/shared/canvas";
import { canvasFromDocument } from "../src/shared/model/from-document";
const work: WorkPolicyRead = { itemsOf: () => [], taskAt: () => undefined, requestItemsOf: () => [], artifactsOf: () => [], artifactsByNode: new Map() };

const agentNode = (
  id = "agent",
  hostId = "local",
  at: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "profile-13",
  x: at.x,
  y: at.y,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: `${hostId}:${id}` },
    terminal: {
      bindingId: `binding-${id}`,
      launch: { kind: "harness", argv: ["claude"] },
      harness: "claude",
    },
    host: hostId,
  },
});

describe("work pure transforms", () => {
  it("appends mail to an agent inbox, keyed to the canvas", () => {
    const doc: CanvasDoc = { nodes: [agentNode()], edges: [] };
    const onAgent = workMessageAppend(work, canvasFromDocument("c", doc), "c", "agent", null, {
      messageId: "manual-2",
      role: "user",
      parts: [{ kind: "text", text: "ping" }],
    });
    expect(onAgent).not.toHaveProperty("doc");
    expect(onAgent.message.messageId).toBe("manual-2");
    expect(onAgent.message.contextId).toBe("c");
  });

  it("uses region label as contextId when the agent is inside a group", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "reg",
          type: "group",
          label: "forge-lane",
          x: 0,
          y: 0,
          width: 400,
          height: 300,
        },
        { ...agentNode("agent", "local", { x: 40, y: 40 }), width: 120, height: 80 },
      ],
      edges: [],
    };
    const appended = workMessageAppend(work, canvasFromDocument("c", doc), "canvas-name", "agent", null, {
      messageId: "inside-1",
      role: "user",
      parts: [{ kind: "text", text: "inside" }],
    });
    expect(appended.message.contextId).toBe("forge-lane");
  });
});

import { Schema } from "effect";
import { TaskBoard, asCanvasName, asNodeId, asWireId, type Canvas } from "../src/shared/model";
import { workTaskCreate, workTaskTransition } from "../src/shared/work";
import type { Task } from "../src/shared/work-model";

const topology = (feeds = true): Canvas => {
  const nodes = ["a", "b"].map((id, z) => Schema.decodeUnknownSync(TaskBoard)({ kind: "task", id, x: z * 300, y: 0, width: 200, height: 100, z }));
  return { name: asCanvasName("c"), seq: 1, nodes: new Map(nodes.map((node) => [node.id, node])),
    wires: feeds ? new Map([[asWireId("path"), { id: asWireId("path"), from: asNodeId("a"), to: asNodeId("b"), verb: "feeds" }]]) : new Map() };
};
const rows = (entries: ReadonlyArray<readonly [string, Task]>): WorkPolicyRead => ({
  ...work,
  itemsOf: (board) => entries.filter(([nodeId]) => nodeId === board).map(([, task]) => task),
  taskAt: (board, id) => entries.find(([nodeId, task]) => nodeId === board && task.id === id)?.[1],
});
const task = (state: Task["state"] = "working"): Task => ({ id: "t", state, history: [{ messageId: "brief", role: "user", parts: [{ kind: "text", text: "ship" }] }] });
let sequence = 0;
const ids = { id: () => "new-task", messageId: () => `message-${++sequence}` };

it("validates explicit prerequisite rows before creating a task", () => {
  expect(() => workTaskCreate(work, topology(), "c", "a", "ship", { details: "description" }, ids, undefined, undefined, ["dependency"])).toThrow();
  const result = workTaskCreate(rows([["a", { ...task("completed"), id: "dependency" }]]), topology(), "c", "a", "ship", { details: "description" }, ids, undefined, undefined, ["dependency"]);
  expect(result.task.dependsOn).toEqual(["dependency"]);
  expect(result).not.toHaveProperty("doc");
});

it("sends a task onward using the destination row's existing thread", () => {
  const previous = { ...task("rejected"), history: [...task().history, { messageId: "prior-visit", role: "agent" as const, parts: [{ kind: "text" as const, text: "prior work" }] }] };
  const result = workTaskTransition(rows([["a", task()], ["b", previous]]), topology(), "c", "a", "t", "completed", "done", ids);
  expect(result.sentOn?.nodeId).toBe("b");
  expect(result.sentOn?.task.state).toBe("submitted");
  expect(result.sentOn?.task.history.map((message) => message.messageId)).toContain("prior-visit");
  expect(result.task.visits?.at(-1)?.exit).toBe("sent-on");
  expect(result).not.toHaveProperty("doc");
});

it("requires and accepts prior-board claims from separate Work rows on terminal close", () => {
  const current: Task = { ...task(), rules: [{ id: "rule", text: "tested", board: "a" }],
    visits: [{ board: "a", enteredAt: "2026-10-07", exitedAt: "2026-10-07", epoch: 0, exit: "sent-on", next: "b" }, { board: "b", enteredAt: "2026-10-07", epoch: 0 }] };
  expect(() => workTaskTransition(rows([["b", current]]), topology(false), "c", "b", "t", "completed", "done", ids)).toThrow(/no claim/);
  const prior: Task = { ...task("completed"), completionEvidence: { artifacts: [], claims: [{ ruleId: "rule", text: "passed" }] } };
  const result = workTaskTransition(rows([["a", prior], ["b", current]]), topology(false), "c", "b", "t", "completed", "done", ids);
  expect(result.task.state).toBe("completed");
});
