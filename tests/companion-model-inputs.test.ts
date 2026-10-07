import { Schema } from "effect";
import { expect, it } from "vitest";
import { Node, asCanvasName, asWireId } from "../src/shared/model";
import { ActorSeatId } from "../src/shared/actor-seat";
import { feedSeatsFromCanvas, feedRegionForCanvas } from "../src/shared/operator-feed";
import { feedCanvasModelNeeds } from "../src/shared/canvas-needs";
import { deriveExecutionGraph } from "../src/shared/execution-graph";
import { mailboxRows } from "../src/renderer/lib/actor-ledger";
import type { Task } from "../src/shared/work-model";

const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"d".repeat(64)}`);
const decode = Schema.decodeUnknownSync(Node);
const region = decode({ kind: "region", id: "region", label: "Ops", x: 0, y: 0, width: 700, height: 400, z: 0, defaults: {}, hold: false });
const seat = decode({ kind: "agent", id: "worker", label: "Worker", agentKey: "local:worker", host: "local", bindingId: "worker", harness: "codex", overseer: false, onRemove: "detach", x: 20, y: 20, width: 100, height: 50, z: 1 });
const task = decode({ kind: "task", id: "queue", name: "Queue", x: 200, y: 20, width: 100, height: 50, z: 2 });
const id = asWireId("contributes");
const canvas = { name: asCanvasName("factory"), seq: 2, nodes: new Map([region, seat, task].map((node) => [node.id, node])), wires: new Map([[id, { id, from: seat.id, to: task.id, verb: "contributes" as const }]]) };

it("companion seats carry canonical identity, harness and region from model kinds", () => {
  const inputs = feedSeatsFromCanvas(canvas, { attentionByNodeId: new Map([[seat.id, { reason: "needs input", at: 12 }]]) });
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({ seat: { nodeId: "worker", name: "Worker", harness: "codex" }, region: { regionId: "region", label: "Ops", path: ["Ops"] }, attention: { reason: "needs input", at: 12 } });
  expect(feedRegionForCanvas(canvas, "queue")).toMatchObject({ regionId: "region" });
});

it("companion canvas needs use separately queried Work waits and their real start time", () => {
  const items: Task[] = [{ id: "waiting", state: "input-required", claimedBy: seatId, stateSince: "2026-10-07T10:00:00.000Z", history: [] }];
  const itemsOf = (nodeId: string) => nodeId === task.id ? items : [];
  const graph = deriveExecutionGraph(canvas, { canvasName: "factory", itemsOf, resolveActorRef: (ref) => ref.nodeId === seat.id ? { canvasName: "factory", nodeId: seat.id, seatId } : undefined });
  const needs = feedCanvasModelNeeds({ canvasName: "factory", canvas, graph, itemsOf });
  expect(needs.find((need) => need.seat.nodeId === task.id)).toMatchObject({ seat: { name: "Queue" }, region: { label: "Ops" }, since: Date.parse("2026-10-07T10:00:00.000Z") });
  expect(needs.find((need) => need.seat.nodeId === seat.id)?.kind).toBe("blocked");
});

it("model mailbox rows retain sender labels and delivered/read receipt state", () => {
  const rows = mailboxRows(canvas, [{ messageId: "receipt", role: "user", parts: [{ kind: "text", text: "hello" }], metadata: { senderNodeId: "worker", fromSeat: seatId, deliveredAt: 8, readAt: 9 } }]);
  expect(rows[0]).toMatchObject({ fromNodeId: "worker", fromLabel: "Worker", body: "hello", delivery: "delivered", read: true });
});
