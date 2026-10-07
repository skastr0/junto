import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Command } from "../src/shared/model";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelService } from "../src/main/junto/model/service";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { MessageDeliveryService } from "../src/main/junto/work/message-delivery";
import { mailboxMessageDeliveryId } from "../src/main/junto/work/mailbox-receipts";
import { canvasReceiptBasis, recordDeliveryReceiptRefusal, stampMailboxDeliveryReceipt } from "../src/main/junto/work/delivery-receipts";
import { observabilityRing } from "../src/main/junto/observability/ring";

it("a delivered mail commits its receipt against the live canvas sequence and survives replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-mail-receipt-"));
  const modelLive = Layer.provideMerge(Layer.provide(ModelLive, ModelDependents.empty), makeStateEngineLive(join(root, "junto.db")));
  let runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, modelLive));
  const delivery = new MessageDeliveryService();
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO station_known_installations VALUES ('receipt-home','2026-10-07')`;
      yield* sql`INSERT INTO station_installation VALUES (1,'receipt-home','2026-10-07')`;
      yield* sql`INSERT INTO station_configuration(singleton,role,host_id,agent_host_id,command_center_installation_id,supervised_preferred,configured_at) VALUES (1,'command-center','local',NULL,NULL,1,'2026-10-07')`;
    })));
    const model = await runtime.runPromise(ModelService);
    let repo = await runtime.runPromise(WorkRepository);
    const refs = await runtime.runPromise(ModelActorRefs);
    const command = Schema.decodeUnknownSync(Command);
    await runtime.runPromise(model.command(command({ _tag: "CreateCanvas", canvas: "factory" }), "operator"));
    await runtime.runPromise(model.command(command({ _tag: "Add", canvas: "factory", nodes: ["sender", "inbox"].map((id) => ({
      kind: "agent", id, x: 0, y: 0, width: 200, height: 100, z: 0, label: id,
      agentKey: `local:${id}`, bindingId: `binding-${id}`, host: "local", harness: "claude", overseer: false, onRemove: "detach",
    })), wires: [] }), "operator"));
    const actors = await runtime.runPromise(refs.read("factory"));
    await runtime.runPromise(repo.appendMessage({
      sink: { canvasName: "factory", nodeId: "inbox" },
      basis: canvasReceiptBasis({ canvasName: "factory", seq: 1 }),
      sentBy: actors.find((ref) => ref.nodeId === "sender")!, destination: { kind: "mailbox" },
      message: { messageId: "delivered-mail", role: "user", parts: [{ kind: "text", text: "hello" }] },
    }));
    // The receipt must use the sequence at delivery, not the one at append.
    await runtime.runPromise(model.command(command({ _tag: "Move", canvas: "factory", moves: [{ id: "inbox", x: 25, y: 50 }] }), "operator"));
    const writes: string[] = [];
    const stamp = () => runtime.runPromise(stampMailboxDeliveryReceipt({ canvas: "factory", nodeId: "inbox", messageId: "delivered-mail", deliveryId: mailboxMessageDeliveryId("factory", "inbox", "delivered-mail") }));
    const configuration: Parameters<MessageDeliveryService["configure"]>[0] = {
      transport: { seatLive: () => true, writeMail: async (_binding, text) => { writes.push(text); return "written"; } },
      store: {
        listCanvasNames: async () => ["factory"],
        readCanvas: (canvas) => runtime.runPromise(Effect.flatMap(ModelService, (model) => model.canvas(canvas))),
        readMessage: (canvas, node, messageId) => runtime.runPromise(repo.mailMessage(canvas, node, messageId)),
        listMail: (canvas, node) => runtime.runPromise(repo.mailbox(canvas, node)),
        acceptMessageDelivery: stamp,
      },
    };
    delivery.configure(configuration);
    expect(await delivery.deliver("factory", "inbox", "delivered-mail")).toBe("delivered");
    expect(writes).toHaveLength(1);
    expect(await stamp()).toBe(true);
    const receipts = await runtime.runPromise(sql`SELECT * FROM work_delivery_receipts WHERE delivered_canvas_name='factory' AND delivered_node_id='inbox'`);
    expect(receipts).toHaveLength(1);
    const facts = await runtime.runPromise(sql`SELECT basis_kind,basis_canvas_name,basis_canvas_seq FROM work_facts AS facts JOIN work_events AS events USING(event_home,entity_home,seq) WHERE events.operation='delivery.accepted'`);
    expect(facts).toEqual([{ basis_kind: "canvas", basis_canvas_name: "factory", basis_canvas_seq: 2 }]);
    expect((await runtime.runPromise(repo.mailMessage("factory", "inbox", "delivered-mail")))?.metadata?.deliveredAt).toBeTypeOf("number");
    delivery.resetForTest();
    await runtime.dispose();
    runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, modelLive));
    repo = await runtime.runPromise(WorkRepository);
    const restarted = new MessageDeliveryService();
    const wakes: string[] = [];
    restarted.configure({ store: configuration.store, transport: {
      seatLive: () => false,
      wakeSeat: async (binding) => { wakes.push(binding); return true; },
      writeMail: async (_binding, text) => { writes.push(text); return "written"; },
    } });
    try {
      await restarted.onBooted();
      await restarted.deliver("factory", "inbox", "delivered-mail");
      expect(writes).toHaveLength(1);
      expect(wakes).toEqual([]);
    } finally { restarted.resetForTest(); }
  } finally { delivery.resetForTest(); await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});

it("logs a refused stamp at error level with its canvas, node, and reason", () => {
  recordDeliveryReceiptRefusal("factory", "inbox", new Error("stale canvas sequence"));
  const entry = observabilityRing.query().entries.find((entry) => entry.message.includes("stale canvas sequence"));
  expect(entry).toMatchObject({ level: "error", source: "system" });
  expect(entry?.message).toContain('"canvas":"factory"');
  expect(entry?.message).toContain('"node":"inbox"');
});
