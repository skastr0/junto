import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { Node, asCanvasName, type Canvas } from "../src/shared/model";
import { ActorSeatId } from "../src/shared/actor-seat";
import { defaultSettings } from "../src/shared/settings";
import type { Task } from "../src/shared/work-model";
import type { TerminalSessionSummary } from "../src/shared/terminal";
import { canvasReceiptBasis } from "../src/main/junto/work/delivery-receipts";
import { makeCheckoutWatchComposition, type CheckoutWatchCompositionOptions } from "../src/main/junto/work/checkout-watch-composition";

const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`);
const seat = Schema.decodeUnknownSync(Node)({ kind: "agent", id: "seat", label: "Worker", x: 0, y: 0, width: 200, height: 100, z: 0, agentKey: "local:codex", host: "local", bindingId: "binding", harness: "codex", overseer: false, onRemove: "detach" });
const board = Schema.decodeUnknownSync(Node)({ kind: "task", id: "queue", x: 0, y: 0, width: 200, height: 100, z: 1 });

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-checkout-model-"));
  let canvas: Canvas = { name: asCanvasName("factory"), seq: 1, nodes: new Map([seat, board].map((node) => [node.id, node])), wires: new Map() };
  let task: Task = { id: "task", state: "working", claimedBy: seatId, history: [] };
  let head = "a".repeat(40);
  const receipts: Array<Parameters<CheckoutWatchCompositionOptions["workRepository"]["publishCheckoutReceipts"]>[0]> = [];
  const records: unknown[] = [];
  const session: TerminalSessionSummary = { bindingId: "binding", epoch: "generation", hostId: "local", status: "running", pid: 123, canvasName: "factory", nodeId: "seat", harness: "codex", agentKey: "local:codex", cwd: root, detached: false, createdAt: 1 };
  const settings = defaultSettings();
  const options: CheckoutWatchCompositionOptions = {
    model: { listCanvases: () => Effect.succeed([canvas.name]), canvas: () => Effect.succeed(canvas) },
    actorRefs: { read: () => Effect.succeed([{ canvasName: "factory", nodeId: "seat", seatId }]) },
    settings: { get: Effect.succeed({ ...settings, station: { ...settings.station, role: "command-center" } }) },
    host: { get: () => session },
    crew: { recordCheckoutObservation: (input) => Effect.sync(() => { records.push(input); return true; }) },
    workRepository: {
      taskLane: () => Effect.succeed([task]),
      publishCheckoutReceipts: (input) => Effect.sync(() => { receipts.push(input); return []; }),
    },
    messageDelivery: { notifyAppended: () => undefined },
    basisFor: canvasReceiptBasis,
    run: Effect.runPromise,
    write: Effect.runPromise,
    probe: { head: async () => ({ branch: "main", head }), newCommits: async () => [head] },
  };
  return { root, options, receipts, records, advance: () => { head = "b".repeat(40); }, resequence: () => { canvas = { ...canvas, seq: canvas.seq + 1 }; }, complete: () => { task = { ...task, state: "completed" }; } };
};

it("checkout receipts use exact task rows and the canvas sequence at commit", async () => {
  const f = await fixture();
  const watch = makeCheckoutWatchComposition({ ...f.options, write: (effect) => { f.resequence(); return Effect.runPromise(effect); } });
  try {
    await Effect.runPromise(watch.scanOnce());
    expect(f.records).toEqual([]);
    f.advance();
    const result = await Effect.runPromise(watch.scanOnce());
    expect(result[0]?.receipt.failed).toBe(0);
    expect(f.receipts).toHaveLength(1);
    expect(f.receipts[0]).toMatchObject({ basis: { kind: "canvas", canvasName: "factory", seq: 2 }, nodeId: "queue", taskId: "task", author: { fromSeat: seatId, senderNodeId: "seat", senderGeneration: "generation", senderHarness: "codex" }, shas: ["b".repeat(40)] });
    expect(f.records).toHaveLength(1);
  } finally { watch.stop(); await rm(f.root, { recursive: true, force: true }); }
});

it("a claim completed while waiting for the authoring gate cannot emit checkout mail", async () => {
  const f = await fixture();
  const watch = makeCheckoutWatchComposition({ ...f.options, write: (effect) => { f.complete(); return Effect.runPromise(effect); } });
  try {
    await Effect.runPromise(watch.scanOnce());
    f.advance();
    const result = await Effect.runPromise(watch.scanOnce());
    expect(f.receipts).toEqual([]);
    expect(f.records).toEqual([]);
    expect(result[0]?.receipt.failed).toBe(1);
  } finally { watch.stop(); await rm(f.root, { recursive: true, force: true }); }
});

it("a canvas change during claim inventory rejects the pass instead of replacing its baseline", async () => {
  const f = await fixture();
  const watch = makeCheckoutWatchComposition({ ...f.options, workRepository: { ...f.options.workRepository, taskLane: () => { f.resequence(); return f.options.workRepository.taskLane("factory", "queue", "task"); } } });
  try {
    await expect(Effect.runPromise(watch.scanOnce())).rejects.toMatchObject({ reason: "checkout-intent-changed" });
    expect(f.receipts).toEqual([]);
    expect(f.records).toEqual([]);
  } finally { watch.stop(); await rm(f.root, { recursive: true, force: true }); }
});
