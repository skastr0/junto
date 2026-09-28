import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  AuthorialIntentFactBasis,
  type ActorRef,
  type IntentFactBasis,
  type WorkRecord,
} from "../src/shared/work-protocol";
import {
  WORK_SEAT_RECENT_OPS_COVERAGE,
  WORK_SEAT_RECENT_OP_DEFAULT_LIMIT,
  WORK_SEAT_RECENT_OP_MAX_LIMIT,
} from "../src/shared/work-recent-ops";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import { authorialMaterialForTest } from "./helpers/task-topology-authority";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";

const canvasName = "factory";
const otherCanvasName = "other-factory";
const opened: Array<{
  readonly root: string;
  readonly dispose: () => Promise<void>;
}> = [];

afterEach(async () => {
  const closing = opened.splice(0);
  await Promise.all(closing.map(({ dispose }) => dispose()));
  await Promise.all(
    closing.map(({ root }) => rm(root, { recursive: true, force: true })),
  );
});

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const actor = (digit: string, nodeId = `actor-${digit}`): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(
    `seat_${digit.repeat(64)}`,
  ),
  canvasName,
  nodeId,
});

const atMinute = (minute: number): string =>
  new Date(Date.UTC(2026, 7, 12, 12, minute)).toISOString();

const factoryTopology: CanvasDoc = {
  nodes: [
    {
      id: "recipient",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: "Recipient",
      ether: { entity: { kind: "agent", name: "local:recipient" } },
    },
  ],
  edges: [],
};
const factoryCanvasBody = serializeCanvas(factoryTopology);
const emptyTopology: CanvasDoc = { nodes: [], edges: [] };
const emptyCanvasBody = serializeCanvas(emptyTopology);
const authorialMaterial = authorialMaterialForTest({
  generation: "1",
  documents: new Map([
    [canvasName, { document: factoryTopology, rawBody: factoryCanvasBody }],
    [otherCanvasName, { document: emptyTopology, rawBody: emptyCanvasBody }],
  ]),
});
const intentSha256 = authorialMaterial.intentSha256;

const openRepository = async (
  local: InstallationIdValue,
  peers: ReadonlyArray<InstallationIdValue> = [],
  role: "command-center" | "remote" = "command-center",
) => {
  const root = join(
    tmpdir(),
    `junto-seat-recent-ops-${local}-${randomUUID()}`,
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "junto.db")),
    ),
  );
  opened.push({ root, dispose: () => runtime.dispose() });
  const repository = await runtime.runPromise(WorkRepository);
  const state = await runtime.runPromise(StateEngine);
  await runtime.runPromise(
    state.transaction("test.seed-seat-recent-ops", (writer) => {
      for (const known of new Set([local, ...peers])) {
        writer.run(
          `
            INSERT INTO station_known_installations(
              installation_id,
              registered_at
            ) VALUES (?, ?)
          `,
          [known, atMinute(0)],
        );
      }
      writer.run(
        `
          INSERT INTO station_installation(
            singleton,
            installation_id,
            created_at
          ) VALUES (1, ?, ?)
        `,
        [local, atMinute(0)],
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
          ) VALUES (1, ?, ?, ?, ?, 1, ?)
        `,
        role === "command-center"
          ? [role, "local", null, null, atMinute(0)]
          : [role, "remote", "remote", peers[0], atMinute(0)],
      );
      seedCanvasAuthority(writer, {
        generation: "1",
        documents: new Map([
          [canvasName, factoryTopology],
          [otherCanvasName, emptyTopology],
        ]),
        at: atMinute(0),
      });
    }),
  );
  const basis = Schema.decodeUnknownSync(AuthorialIntentFactBasis)({
    kind: "authorial-intent",
    generation: "1",
    contentSha256: intentSha256,
  });
  return { runtime, repository, basis };
};

const message = (messageId: string, text: string) => ({
  messageId,
  role: "user" as const,
  parts: [{ kind: "text" as const, text }],
  contextId: canvasName,
});

const appendMailboxMessage = (
  repository: typeof WorkRepository.Service,
  basis: IntentFactBasis,
  sentBy: ActorRef,
  input: {
    readonly id: string;
    readonly text: string;
    readonly at: string;
    readonly canvas?: string;
  },
) =>
  repository.appendMessage({
    sink: {
      canvasName: input.canvas ?? canvasName,
      nodeId: "recipient",
    },
    basis,
    message: {
      ...message(input.id, input.text),
      contextId: input.canvas ?? canvasName,
    },
    sentBy: {
      ...sentBy,
      canvasName: input.canvas ?? canvasName,
    },
    destination: { kind: "mailbox" },
    originAt: input.at,
    receivedAt: input.at,
  });

const admitted = () => ({ _tag: "admitted" as const });

const accept = (
  repository: typeof WorkRepository.Service,
  senderInstallationId: InstallationIdValue,
  records: ReadonlyArray<WorkRecord>,
  receivedAt: string,
  authorizeCommand: Parameters<
    typeof repository.acceptRecords
  >[0]["authorizeCommand"] = admitted,
) =>
  repository.acceptRecords({
    senderInstallationId,
    records,
    peerAcknowledgements: [],
    receivedAt,
    authorizeCommand,
    authorizeFact: admitted,
    admitResponse: admitted,
  });

describe("WorkRepository recent actor-seat operations", () => {
  it("returns the exact identity-backed subset with safe summaries", async () => {
    const local = installation("cc-seat-recent-ops");
    const { runtime, repository, basis } = await openRepository(local);
    const seat = actor("1", "worker");
    const otherSeat = actor("2", "other-worker");

    await runtime.runPromise(
      appendMailboxMessage(repository, basis, seat, {
        id: "message-1",
        text: "SECRET_MESSAGE_BODY",
        at: atMinute(6),
      }),
    );
    await runtime.runPromise(
      repository.acceptDelivery({
        sink: { canvasName, nodeId: "recipient" },
        basis,
        receipt: {
          deliveryId: "delivery-1",
          deliveredItem: {
            kind: "message",
            itemId: "message-1",
            sink: { canvasName, nodeId: "recipient" },
          },
          actor: seat,
          acceptedAt: atMinute(8),
        },
        originAt: atMinute(8),
        receivedAt: atMinute(8),
      }),
    );
    await runtime.runPromise(
      appendMailboxMessage(repository, basis, otherSeat, {
        id: "other-seat-message",
        text: "OTHER_SEAT_SECRET",
        at: atMinute(12),
      }),
    );
    await runtime.runPromise(
      appendMailboxMessage(repository, basis, seat, {
        id: "other-canvas-message",
        text: "OTHER_CANVAS_SECRET",
        at: atMinute(13),
        canvas: otherCanvasName,
      }),
    );

    const feed = await runtime.runPromise(
      repository.recentOpsForSeat({
        canvasName,
        actorSeatId: seat.seatId,
        limit: 50,
      }),
    );

    expect(feed.operations.map(({ operation }) => operation)).toEqual([
      "delivery.accepted",
      "message.append",
    ]);
    expect(feed.lastOpAt).toBe(atMinute(8));
    expect(feed.coverage).toEqual(WORK_SEAT_RECENT_OPS_COVERAGE);
    expect(feed.operations).toEqual([
      expect.objectContaining({
        summary: {
          kind: "delivery",
          deliveryId: "delivery-1",
          delivered: {
            kind: "message",
            itemId: "message-1",
            targetNodeId: "recipient",
          },
        },
      }),
      expect.objectContaining({
        targetNodeId: "recipient",
        summary: { kind: "message", messageId: "message-1" },
      }),
    ]);
    const exposed = JSON.stringify(feed);
    for (const secret of [
      "SECRET_MESSAGE_BODY",
      "OTHER_SEAT_SECRET",
      "OTHER_CANVAS_SECRET",
    ]) {
      expect(exposed).not.toContain(secret);
    }
  });

  it("defaults to 20 entries and hard-caps the limit at 50", async () => {
    const local = installation("cc-seat-recent-limits");
    const { runtime, repository, basis } = await openRepository(local);
    const seat = actor("3", "limit-worker");
    for (let index = 0; index < 55; index += 1) {
      await runtime.runPromise(
        appendMailboxMessage(repository, basis, seat, {
          id: `message-${index.toString().padStart(2, "0")}`,
          text: `body-${index}`,
          at: atMinute(index),
        }),
      );
    }

    const defaultFeed = await runtime.runPromise(
      repository.recentOpsForSeat({
        canvasName,
        actorSeatId: seat.seatId,
      }),
    );
    const cappedFeed = await runtime.runPromise(
      repository.recentOpsForSeat({
        canvasName,
        actorSeatId: seat.seatId,
        limit: 500,
      }),
    );

    expect(defaultFeed.operations).toHaveLength(
      WORK_SEAT_RECENT_OP_DEFAULT_LIMIT,
    );
    expect(cappedFeed.operations).toHaveLength(WORK_SEAT_RECENT_OP_MAX_LIMIT);
    expect(defaultFeed.operations[0]?.summary).toEqual({
      kind: "message",
      messageId: "message-54",
    });
    expect(cappedFeed.operations.at(-1)?.summary).toEqual({
      kind: "message",
      messageId: "message-05",
    });
  });

  it("uses command origin and authority apply times for remote operations", async () => {
    const commandCenterId = installation("cc-seat-remote-command");
    const remoteId = installation("remote-seat-command");
    const commandCenter = await openRepository(
      commandCenterId,
      [remoteId],
      "command-center",
    );
    const remote = await openRepository(remoteId, [commandCenterId], "remote");
    const seat = actor("4", "remote-worker");
    const sink = { canvasName, nodeId: "recipient" };
    const command = await remote.runtime.runPromise(
      remote.repository.enqueueRemoteCommand({
        targetInstallationId: commandCenterId,
        sink,
        item: { kind: "message", itemId: "remote-message", sink },
        action: {
          operation: "message.append",
          message: message("remote-message", "SECRET_REMOTE_MESSAGE"),
          sentBy: seat,
          destination: { kind: "mailbox" },
        },
        originAt: atMinute(1),
        receivedAt: atMinute(1),
      }),
    );
    await commandCenter.runtime.runPromise(
      accept(
        commandCenter.repository,
        remoteId,
        [command],
        atMinute(2),
      ),
    );
    const rejected = await remote.runtime.runPromise(
      remote.repository.enqueueRemoteCommand({
        targetInstallationId: commandCenterId,
        sink,
        item: { kind: "message", itemId: "rejected-message", sink },
        action: {
          operation: "message.append",
          message: message("rejected-message", "SECRET_REJECTED_MESSAGE"),
          sentBy: seat,
          destination: { kind: "mailbox" },
        },
        originAt: atMinute(3),
        receivedAt: atMinute(3),
      }),
    );
    await commandCenter.runtime.runPromise(
      accept(
        commandCenter.repository,
        remoteId,
        [rejected],
        atMinute(4),
        () => ({
          _tag: "rejected",
          reason: "capability-denied",
          message: "test rejection",
        }),
      ),
    );
    const feed = await commandCenter.runtime.runPromise(
      commandCenter.repository.recentOpsForSeat({
        canvasName,
        actorSeatId: seat.seatId,
      }),
    );

    expect(feed.operations).toEqual([
      {
        operation: "message.append",
        originAt: atMinute(1),
        appliedAt: atMinute(2),
        targetNodeId: "recipient",
        summary: { kind: "message", messageId: "remote-message" },
      },
    ]);
    expect(feed.lastOpAt).toBe(atMinute(2));
    expect(JSON.stringify(feed)).not.toContain("SECRET_REMOTE_MESSAGE");
    expect(JSON.stringify(feed)).not.toContain("SECRET_REJECTED_MESSAGE");
  });
});
