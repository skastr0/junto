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
import { canvasReceiptBasis } from "../src/main/junto/work/delivery-receipts";
import { makeMessageDeliveryStore } from "../src/main/junto/work/message-delivery-store";
import { ContentService, type ContentServiceShape } from "../src/main/junto/content/service";
import { THIS_MACHINE } from "./support/machines";

it("a delivery that typed the mail whole stamps it read with its receipt; any other leaves it unread", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-mail-read-stamp-"));
  const modelLive = Layer.provideMerge(Layer.provide(ModelLive, ModelDependents.empty), makeStateEngineLive(join(root, "junto.db")));
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, modelLive));
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO known_installations VALUES ('read-home','2026-10-19')`;
      yield* sql`INSERT INTO installation VALUES (1,'read-home','2026-10-19')`;
      yield* sql`INSERT INTO machine_configuration(singleton, machine_name, supervised_preferred, configured_at) VALUES (1, ${THIS_MACHINE}, 1, '2026-10-19')`;
    })));
    const model = await runtime.runPromise(ModelService);
    const repo = await runtime.runPromise(WorkRepository);
    const refs = await runtime.runPromise(ModelActorRefs);
    const command = Schema.decodeUnknownSync(Command);
    await runtime.runPromise(model.command(command({ _tag: "CreateCanvas", canvas: "factory" }), "operator"));
    await runtime.runPromise(model.command(command({ _tag: "Add", canvas: "factory", nodes: ["sender", "inbox"].map((id) => ({
      kind: "agent", id, x: 0, y: 0, width: 200, height: 100, z: 0, label: id,
      agentKey: `local:${id}`, bindingId: `binding-${id}`, host: THIS_MACHINE, harness: "claude", overseer: false,
    })), wires: [] }), "operator"));
    const sender = (await runtime.runPromise(refs.read("factory"))).find((ref) => ref.nodeId === "sender")!;
    for (const messageId of ["whole-mail", "cut-mail"]) {
      await runtime.runPromise(repo.appendMessage({
        sink: { canvasName: "factory", nodeId: "inbox" },
        basis: canvasReceiptBasis({ canvasName: "factory", seq: 1 }),
        sentBy: sender, destination: { kind: "mailbox" },
        message: { messageId, role: "user", parts: [{ kind: "text", text: messageId }] },
      }));
    }
    // These mails carry no files, so the content store is never read.
    const store = await runtime.runPromise(
      makeMessageDeliveryStore.pipe(Effect.provideService(ContentService, {} as ContentServiceShape)),
    );
    expect(await store.acceptMessageDelivery("factory", "inbox", "whole-mail", true)).toBe(true);
    expect(await store.acceptMessageDelivery("factory", "inbox", "cut-mail", false)).toBe(true);
    // A second stamp of the same delivery changes nothing.
    expect(await store.acceptMessageDelivery("factory", "inbox", "whole-mail", true)).toBe(true);

    const whole = await store.readMessage("factory", "inbox", "whole-mail");
    expect(whole?.metadata?.deliveredAt).toBeTypeOf("number");
    expect(whole?.metadata?.readAt).toBeTypeOf("number");
    const cut = await store.readMessage("factory", "inbox", "cut-mail");
    expect(cut?.metadata?.deliveredAt).toBeTypeOf("number");
    expect(cut?.metadata?.readAt).toBeUndefined();
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
