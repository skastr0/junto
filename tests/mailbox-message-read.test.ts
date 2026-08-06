/**
 * L2 mail nits: durable read-ack idempotency (stable readAt).
 * Control-plane foreign-mailbox refusal lives in work-control-transport.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";
import {
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum/station/fleet-target-repository";
import { StationRepositoryLive } from "../src/main/vellum/station/repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum/station/session-registry";
import { mailboxMessageReadId } from "../src/main/vellum/work/mailbox-receipts";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";
import {
  makeContentServiceLive,
} from "../src/main/vellum/content/service";
import { makeInstallOpsLive } from "../src/main/vellum/install-ops/engine";

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
  const stateLive = makeStateEngineLive(join(root, "state", "vellum.db"));
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
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
  const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
  const workLive = Layer.provideMerge(
    WorkLive,
    Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive),
  );
  return ManagedRuntime.make(workLive as never);
};

const agentDoc = (): CanvasDoc => ({
  nodes: [
    {
      id: "agent",
      type: "text",
      x: 0,
      y: 0,
      width: 120,
      height: 48,
      text: "agent",
      ether: {
        entity: { kind: "agent", name: "local:agent" },
        terminal: {
          bindingId: "bind-agent",
          harness: "claude",
          launch: { kind: "harness", argv: ["claude"] },
        },
      },
    },
  ],
  edges: [],
});

const authorialBasis = (generation: string, contentSha256: string) =>
  Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })({
    kind: "authorial-intent",
    generation,
    contentSha256,
  });

describe("mailbox message read receipts", () => {
  it("acceptedDeliveryAt returns durable accepted_at; re-accept conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-mail-read-"));
    roots.push(root);
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "canvases"), { recursive: true });
    process.env.VELLUM_COMMAND_CANVASES_DIR = join(root, "canvases");
    const runtime = makeRuntime(root);
    runtimes.push(runtime);

    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(
      settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("mail", agentDoc()));
    const repository = await runtime.runPromise(WorkRepository);
    const witness = await runtime.runPromise(canvases.activeIntentWitness());
    const basis = authorialBasis(witness.generation, witness.contentSha256);
    const read = await runtime.runPromise(canvases.read("mail"));
    const actor = read.actorRefs.find((a) => a.nodeId === "agent");
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
    const root = await mkdtemp(join(tmpdir(), "vellum-mail-mark-"));
    roots.push(root);
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "canvases"), { recursive: true });
    process.env.VELLUM_COMMAND_CANVASES_DIR = join(root, "canvases");
    const runtime = makeRuntime(root);
    runtimes.push(runtime);

    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(
      settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      }),
    );
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("mail", agentDoc()));
    const repository = await runtime.runPromise(WorkRepository);
    const witness = await runtime.runPromise(canvases.activeIntentWitness());
    const basis = authorialBasis(witness.generation, witness.contentSha256);
    const read = await runtime.runPromise(canvases.read("mail"));
    const actor = read.actorRefs.find((a) => a.nodeId === "agent");
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
