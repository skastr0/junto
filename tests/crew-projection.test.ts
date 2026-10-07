import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { ModelStoresLive, readSeeded, seedCanvas } from "./support/seed-canvas";
import { seat, wire } from "./support/model-nodes";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { mailboxMessageDeliveryId, mailboxMessageReactId, mailboxMessageReadId } from "../src/main/junto/work/mailbox-receipts";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { IntentFactBasis } from "../src/shared/work-protocol";

const CANVAS = "crew-projection";
const INSTALLATION = "cc-crew-projection";
const mailSink = { canvasName: CANVAS, nodeId: "recipient" };
const iso = (offset: number) => new Date(Date.UTC(2026, 8, 15) + offset).toISOString();
const roots: string[] = [];
const runtimes: Array<{ dispose: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()!.dispose();
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

const nodes = ["author", "recipient", "other-recipient"].map((id) =>
  seat(id, {
    agentKey: `local:crew-projection-${id}`,
    bindingId: `crew-projection-${id}` as never,
    launch: { kind: "harness", argv: ["claude"] },
  }));
const wires = [wire("mail", "author", "recipient", "messages")];

const openFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-crew-projection-"));
  roots.push(root);
  const runtime = ManagedRuntime.make(Layer.provideMerge(
    ModelStoresLive,
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "state", "junto.db")),
    ),
  ));
  runtimes.push(runtime);
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
    yield* sql`INSERT INTO station_known_installations(installation_id, registered_at) VALUES (${INSTALLATION}, ${iso(0)})`;
    yield* sql`INSERT INTO station_installation(singleton, installation_id, created_at) VALUES (1, ${INSTALLATION}, ${iso(0)})`;
    yield* sql`INSERT INTO station_configuration(singleton, role, host_id, agent_host_id,
      command_center_installation_id, supervised_preferred, configured_at)
      VALUES (1, 'command-center', 'local', NULL, NULL, 1, ${iso(0)})`;
  })));
  const work = await runtime.runPromise(WorkRepository);
  await runtime.runPromise(seedCanvas(CANVAS, nodes, wires));
  const refs = await runtime.runPromise(Effect.flatMap(ModelActorRefs, (actors) => actors.read(CANVAS)));
  const author = refs.find((actor) => actor.nodeId === "author")!;
  const recipient = refs.find((actor) => actor.nodeId === "recipient")!;
  expect(author).toBeDefined();
  expect(recipient).toBeDefined();
  const basis = Schema.decodeUnknownSync(IntentFactBasis)({
    kind: "canvas", canvasName: CANVAS, seq: (await runtime.runPromise(readSeeded(CANVAS))).seq,
  });
  const message = async (id: string) => {
    const found = await runtime.runPromise(work.mailMessage(CANVAS, mailSink.nodeId, id));
    expect(found, `projected mailbox message ${id}`).toBeDefined();
    return found!;
  };
  const appendMessage = (id: string) => runtime.runPromise(work.appendMessage({
    sink: mailSink, basis, sentBy: author, destination: { kind: "mailbox" },
    message: { messageId: id, role: "user", parts: [{ kind: "text", text: "Review the delivery" }], metadata: { note: "keep original metadata" } },
    originAt: iso(0), receivedAt: iso(0),
  }));
  return { runtime, work, recipient, basis, message, appendMessage };
};

describe("Crew facts over the model and the work repository", () => {
  it("projects independently timestamped delivery, read and reaction receipts onto the message", async () => {
    const f = await openFixture();
    const id = "attempt-and-receipts";
    await f.appendMessage(id);
    for (const [deliveryId, at] of [
      [mailboxMessageDeliveryId(CANVAS, mailSink.nodeId, id), iso(1)],
      [mailboxMessageReadId(CANVAS, mailSink.nodeId, id), iso(2)],
      [mailboxMessageReactId(CANVAS, mailSink.nodeId, id, "ack"), iso(3)],
    ]) {
      await f.runtime.runPromise(f.work.acceptDelivery({
        sink: mailSink, basis: f.basis,
        receipt: { deliveryId, deliveredItem: { kind: "message", itemId: id, sink: mailSink }, actor: f.recipient, acceptedAt: at },
      }));
    }
    const after = await f.message(id);
    expect(after.metadata).toMatchObject({
      note: "keep original metadata",
      deliveredAt: Date.parse(iso(1)),
      readAt: Date.parse(iso(2)),
      reactions: [{ kind: "ack", at: Date.parse(iso(3)) }],
    });
  });
});
