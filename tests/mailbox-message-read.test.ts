/**
 * L2 mail nits: durable read-ack idempotency (stable readAt).
 * Control-plane foreign-mailbox refusal lives in work-control-transport.
 */
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { Canvas } from "../src/shared/model";
import type { ActorRef } from "../src/shared/work-protocol";
import { seat } from "./support/model-nodes";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { ModelStoresLive, readSeeded, seedCanvas } from "./support/seed-canvas";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/junto/settings/service";
import { makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { mailboxMessageReadId } from "../src/main/junto/work/mailbox-receipts";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { WorkLive, WorkService } from "../src/main/junto/work/service";
import {
  makeContentServiceLive,
} from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { THIS_MACHINE } from "./support/machines";

const roots: string[] = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.dispose();
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const makeRuntime = (root: string) => {
  const stateLive = makeStateEngineLive(join(root, "state", "junto.db"));
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
      SettingsLive,
      makeContentServiceLive({
        root: join(root, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      stateLive,
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(ModelStoresLive, repositoriesLive);
  const workLive = Layer.provideMerge(
    WorkLive,
    canvasesLive,
  );
  return ManagedRuntime.make(workLive as never);
};

const agentNodes = () => [
  seat("agent", {
    width: 120,
    height: 48,
    bindingId: "bind-agent" as never,
    launch: { kind: "harness", argv: ["claude"] },
  }),
];

/** The canvas the mail was written against, by its sequence. */
const authorialBasis = (seq: number) =>
  Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })({
    kind: "canvas",
    canvasName: "mail",
    seq,
  });

describe("mailbox message read receipts", () => {
  it("acceptedDeliveryAt returns durable accepted_at; re-accept conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-mail-read-"));
    roots.push(root);
    mkdirSync(join(root, "state"), { recursive: true });
    const runtime = makeRuntime(root);
    runtimes.push(runtime);

    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(
      settings.setMachinePreferences({ supervisedPreferred: true }),
    );
    await runtime.runPromise(seedCanvas("mail", agentNodes()) as never);
    const repository = await runtime.runPromise(WorkRepository);
    const basis = authorialBasis(((await runtime.runPromise(readSeeded("mail") as never)) as Canvas).seq);
    const refs = (await runtime.runPromise(
      Effect.flatMap(ModelActorRefs, (actors) => actors.read("mail")) as never,
    )) as ReadonlyArray<ActorRef>;
    const actor = refs.find((a) => a.nodeId === "agent");
    expect(actor).toBeDefined();
    const sink = { canvasName: "mail", nodeId: "agent" };
    const messageId = "mail-read-1";
    await runtime.runPromise(
      repository.appendMessage({
        sink,
        basis,
        message: {
          messageId,
          role: "user",
          parts: [{ kind: "text", text: "hello" }],
        },
        sentBy: actor!,
        destination: { kind: "mailbox" },
      }),
    );
    const deliveryId = mailboxMessageReadId("mail", "agent", messageId);
    const acceptedAt = "2026-07-31T00:00:00.000Z";
    await runtime.runPromise(
      repository.acceptDelivery({
        sink,
        basis,
        receipt: {
          deliveryId,
          deliveredItem: { kind: "message", itemId: messageId, sink },
          actor: actor!,
          acceptedAt,
        },
      }),
    );
    expect(
      await runtime.runPromise(repository.acceptedDeliveryAt(sink, deliveryId)),
    ).toBe(acceptedAt);

    const second = await runtime.runPromise(
      repository
        .acceptDelivery({
          sink,
          basis,
          receipt: {
            deliveryId,
            deliveredItem: { kind: "message", itemId: messageId, sink },
            actor: actor!,
            acceptedAt: "2026-07-31T12:00:00.000Z",
          },
        })
        .pipe(Effect.result),
    );
    expect(second._tag).toBe("Failure");
    expect(
      await runtime.runPromise(repository.acceptedDeliveryAt(sink, deliveryId)),
    ).toBe(acceptedAt);
  });

  it("workMessageMarkRead re-acks with the stored readAt", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-mail-mark-"));
    roots.push(root);
    mkdirSync(join(root, "state"), { recursive: true });
    const runtime = makeRuntime(root);
    runtimes.push(runtime);

    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(
      settings.setMachinePreferences({ supervisedPreferred: true }),
    );
    await runtime.runPromise(seedCanvas("mail", agentNodes()) as never);
    const repository = await runtime.runPromise(WorkRepository);
    const basis = authorialBasis(((await runtime.runPromise(readSeeded("mail") as never)) as Canvas).seq);
    const refs = (await runtime.runPromise(
      Effect.flatMap(ModelActorRefs, (actors) => actors.read("mail")) as never,
    )) as ReadonlyArray<ActorRef>;
    const actor = refs.find((a) => a.nodeId === "agent");
    expect(actor).toBeDefined();
    const sink = { canvasName: "mail", nodeId: "agent" };
    const messageId = "mail-read-2";
    await runtime.runPromise(
      repository.appendMessage({
        sink,
        basis,
        message: {
          messageId,
          role: "user",
          parts: [{ kind: "text", text: "ping" }],
        },
        sentBy: actor!,
        destination: { kind: "mailbox" },
      }),
    );

    const work = await runtime.runPromise(WorkService);
    const first = await runtime.runPromise(
      work.workMessageMarkRead("mail", "agent", messageId, actor!),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstAt = first.data.readAt;
    expect(firstAt.length).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 15));
    const second = await runtime.runPromise(
      work.workMessageMarkRead("mail", "agent", messageId, actor!),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.readAt).toBe(firstAt);
  });
});
