// Mailbox metadata admission: reserved projection keys never become durable.
//
// deliveredAt / readAt are projection-only — loadInbox stamps them from
// durable delivery receipts. A caller-supplied value on an appended message
// is a forgery vector (a forged deliveredAt suppresses real delivery; a
// forged readAt lies about read state), so admission strips both keys before
// the row is written. fromSeat is the sender identity the renderer trusts;
// admission rebinds a caller-supplied value that disagrees with the durable
// sender (sentBy) to the sender's node id.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Context,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum-command/work/repository";
import {
  mailboxMessageDeliveryId,
  mailboxMessageReadId,
} from "../src/main/vellum-command/work/mailbox-receipts";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum-command/state/engine";
import { IntentFactBasis } from "../src/shared/work-protocol";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  canvasAuthorityMaterialFixture,
  seedCanvasAuthority,
} from "./helpers/canvas-authority-material";

const root = join(tmpdir(), `vellum-command-mailbox-admission-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "vellum-command.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const observedAt = "2026-08-12T10:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-mailbox-admission");
const factoryDoc: CanvasDoc = {
  nodes: [
    {
      id: "note",
      type: "text",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      text: "factory",
    },
  ],
  edges: [],
};
const fixtureDocuments = new Map<string, CanvasDoc>([["factory", factoryDoc]]);
const currentIntentSha256 = canvasAuthorityMaterialFixture(
  "1",
  fixtureDocuments,
).intentSha256;
const authorialBasis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
})({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: currentIntentSha256,
});

const sender = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`),
  canvasName: "factory",
  nodeId: "builder",
};

const seedInstallations = () =>
  state.transaction("test.seed-installations", (writer) => {
    writer.run(
      `
        INSERT INTO station_known_installations(
          installation_id,
          registered_at
        ) VALUES (?, ?)
      `,
      [cc, observedAt],
    );
    writer.run(
      `
        INSERT INTO station_installation(
          singleton,
          installation_id,
          created_at
        ) VALUES (1, ?, ?)
      `,
      [cc, observedAt],
    );
    writer.run(
      `
        INSERT INTO station_configuration(
          singleton,
          role,
          host_id,
          agent_host_id,
          command_center_installation_id,
          supervised_preferred,
          configured_at
        ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, ?)
      `,
      [observedAt],
    );
    seedCanvasAuthority(writer, {
      generation: "1",
      documents: fixtureDocuments,
      at: observedAt,
    });
  });

beforeAll(async () => {
  repository = await runtime.runPromise(WorkRepository);
  state = await runtime.runPromise(StateEngine);
  await runtime.runPromise(seedInstallations());
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const appendMailboxMessage = (
  sink: { canvasName: string; nodeId: string },
  messageId: string,
  metadata: Record<string, unknown> | undefined,
) =>
  runtime.runPromise(
    repository.appendMessage({
      sink,
      basis: authorialBasis,
      message: {
        messageId,
        role: "user",
        parts: [{ kind: "text", text: "hello" }],
        contextId: "factory",
        ...(metadata === undefined ? {} : { metadata }),
      },
      sentBy: sender,
      destination: { kind: "mailbox" },
      originAt: observedAt,
      receivedAt: observedAt,
    }),
  );

const projectedMessage = async (
  sink: { canvasName: string; nodeId: string },
  messageId: string,
) => {
  const snapshot = await runtime.runPromise(
    repository.readSnapshot(sink.canvasName, sink.nodeId),
  );
  const message = snapshot.messages.items.find(
    (item) => item.messageId === messageId,
  );
  expect(message).toBeDefined();
  return message!;
};

const durableMetadataJson = (
  sink: { canvasName: string; nodeId: string },
  messageId: string,
) =>
  runtime.runPromise(
    state.read("test.read-metadata", (reader) =>
      reader.get<{ readonly metadata_json: string | null }>(
        `SELECT metadata_json FROM work_messages
         WHERE canvas_name = ? AND node_id = ? AND message_id = ?`,
        [sink.canvasName, sink.nodeId, messageId],
      ),
    ),
  );

describe("mailbox metadata admission", () => {
  it("strips forged deliveredAt/readAt at admission and keeps legitimate keys", async () => {
    const sink = { canvasName: "factory", nodeId: "forged-mailbox" };
    const messageId = "forged-delivery-1";
    const result = await appendMailboxMessage(sink, messageId, {
      factoryMail: true,
      fromSeat: sender.nodeId,
      note: "keep me",
      deliveredAt: 1754990000000,
      readAt: 1754990001000,
    });

    // The minted fact value (drives the delivery nudge) is already clean.
    expect(result.value.metadata).toEqual({
      factoryMail: true,
      fromSeat: sender.nodeId,
      note: "keep me",
    });

    // The durable row never carries the reserved keys.
    const row = await durableMetadataJson(sink, messageId);
    expect(row).toBeDefined();
    const durable = JSON.parse(row!.metadata_json ?? "{}") as Record<
      string,
      unknown
    >;
    expect(durable).toEqual({
      factoryMail: true,
      fromSeat: sender.nodeId,
      note: "keep me",
    });

    // Projection shows the message as pending until real receipts exist.
    const before = await projectedMessage(sink, messageId);
    expect(before.metadata?.deliveredAt).toBeUndefined();
    expect(before.metadata?.readAt).toBeUndefined();
    expect(before.metadata?.factoryMail).toBe(true);
    expect(before.metadata?.note).toBe("keep me");

    // Real receipts flip the projection to receipt-derived values.
    const deliveredAcceptedAt = "2026-08-12T11:00:00.000Z";
    await runtime.runPromise(
      repository.acceptDelivery({
        sink,
        basis: authorialBasis,
        receipt: {
          deliveryId: mailboxMessageDeliveryId(
            sink.canvasName,
            sink.nodeId,
            messageId,
          ),
          deliveredItem: { kind: "message", itemId: messageId, sink },
          actor: sender,
          acceptedAt: deliveredAcceptedAt,
        },
      }),
    );
    const readAcceptedAt = "2026-08-12T11:05:00.000Z";
    await runtime.runPromise(
      repository.acceptDelivery({
        sink,
        basis: authorialBasis,
        receipt: {
          deliveryId: mailboxMessageReadId(
            sink.canvasName,
            sink.nodeId,
            messageId,
          ),
          deliveredItem: { kind: "message", itemId: messageId, sink },
          actor: sender,
          acceptedAt: readAcceptedAt,
        },
      }),
    );
    const after = await projectedMessage(sink, messageId);
    expect(after.metadata?.deliveredAt).toBe(Date.parse(deliveredAcceptedAt));
    expect(after.metadata?.readAt).toBe(Date.parse(readAcceptedAt));
    expect(after.metadata?.factoryMail).toBe(true);
    expect(after.metadata?.note).toBe("keep me");
  });

  it("drops the metadata record entirely when only reserved keys were supplied", async () => {
    const sink = { canvasName: "factory", nodeId: "reserved-only-mailbox" };
    const messageId = "reserved-only-1";
    const result = await appendMailboxMessage(sink, messageId, {
      deliveredAt: 1754990000000,
      readAt: 1754990001000,
      reactions: [{ kind: "ack", at: 1754990002000 }],
    });
    expect(result.value.metadata).toBeUndefined();

    const row = await durableMetadataJson(sink, messageId);
    expect(row).toBeDefined();
    expect(row!.metadata_json).toBeNull();

    const projected = await projectedMessage(sink, messageId);
    expect(projected.metadata).toBeUndefined();
  });

  it("rebinds a spoofed fromSeat to the durable sender node", async () => {
    const sink = { canvasName: "factory", nodeId: "spoofed-sender-mailbox" };
    const messageId = "spoofed-from-1";
    const result = await appendMailboxMessage(sink, messageId, {
      factoryMail: true,
      fromSeat: "impostor-node",
    });
    expect(result.value.metadata?.fromSeat).toBe(sender.nodeId);

    const projected = await projectedMessage(sink, messageId);
    expect(projected.metadata?.fromSeat).toBe(sender.nodeId);
    expect(projected.metadata?.factoryMail).toBe(true);
  });

  it("keeps a matching fromSeat and untouched metadata as supplied", async () => {
    const sink = { canvasName: "factory", nodeId: "honest-sender-mailbox" };
    const messageId = "honest-from-1";
    const result = await appendMailboxMessage(sink, messageId, {
      factoryMail: true,
      fromSeat: sender.nodeId,
    });
    expect(result.value.metadata).toEqual({
      factoryMail: true,
      fromSeat: sender.nodeId,
    });

    const projected = await projectedMessage(sink, messageId);
    expect(projected.metadata).toEqual({
      factoryMail: true,
      fromSeat: sender.nodeId,
    });
  });
});
