import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { CanvasDoc } from "../src/shared/canvas";
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
  WORK_SEAT_RECENT_OP_DEFAULT_LIMIT,
  WORK_SEAT_RECENT_OP_MAX_LIMIT,
} from "../src/shared/work-recent-ops";
import {
  createTaskDependencyScopeCapability,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";

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
      id: "tasks",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: "Tasks",
      ether: { entity: { kind: "task" } },
    },
  ],
  edges: [],
};
const factoryCanvasBody = JSON.stringify(factoryTopology);
const factoryCanvasSha256 = createHash("sha256")
  .update(factoryCanvasBody, "utf8")
  .digest("hex");
const emptyCanvasBody = JSON.stringify({ nodes: [], edges: [] });
const emptyCanvasSha256 = createHash("sha256")
  .update(emptyCanvasBody, "utf8")
  .digest("hex");
const intentSha256 = "a".repeat(64);

const openRepository = async (
  local: InstallationIdValue,
  peers: ReadonlyArray<InstallationIdValue> = [],
  role: "command-center" | "remote" = "command-center",
) => {
  const root = join(
    tmpdir(),
    `vellum-command-seat-recent-ops-${local}-${randomUUID()}`,
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "vellum-command.db")),
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
      writer.run(
        `
          INSERT INTO canvas_generations(
            generation,
            created_at,
            cause,
            intent_sha256,
            document_count
          ) VALUES ('1', ?, ?, ?, 2)
        `,
        [atMinute(0), "test recent seat operations", intentSha256],
      );
      for (const name of [canvasName, otherCanvasName]) {
        const body = name === canvasName ? factoryCanvasBody : emptyCanvasBody;
        const sha256 =
          name === canvasName ? factoryCanvasSha256 : emptyCanvasSha256;
        writer.run(
          `
            INSERT INTO canvas_generation_documents(
              generation,
              name,
              body,
              sha256,
              modified_at
            ) VALUES ('1', ?, ?, ?, ?)
          `,
          [name, body, sha256, atMinute(0)],
        );
      }
      writer.run(
        "INSERT INTO canvas_head(singleton, generation) VALUES (1, '1')",
      );
    }),
  );
  const basis = Schema.decodeUnknownSync(AuthorialIntentFactBasis)({
    kind: "authorial-intent",
    generation: "1",
    contentSha256: intentSha256,
  });
  return { runtime, repository, basis };
};

const message = (messageId: string, text: string, taskId?: string) => ({
  messageId,
  role: "user" as const,
  parts: [{ kind: "text" as const, text }],
  contextId: canvasName,
  ...(taskId === undefined ? {} : { taskId }),
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
    const taskSink = { canvasName, nodeId: "tasks" };

    await runtime.runPromise(
      repository.createProposal({
        sink: taskSink,
        basis,
        proposal: {
          id: "proposal-1",
          state: "pending",
          brief: message(
            "proposal-brief",
            "SECRET_PROPOSAL_BODY",
            "proposal-1",
          ),
          proposedBy: seat,
        },
        originAt: atMinute(1),
        receivedAt: atMinute(1),
      }),
    );
    await runtime.runPromise(
      repository.createTask({
        sink: taskSink,
        basis,
        task: {
          id: "task-1",
          state: "submitted",
          history: [message("task-brief", "SECRET_TASK_BODY", "task-1")],
        },
        originAt: atMinute(2),
        receivedAt: atMinute(2),
      }),
    );
    await runtime.runPromise(
      repository.claimLocalTask({
        sink: taskSink,
        basis,
        dependencyScope: createTaskDependencyScopeCapability({
          topology: factoryTopology,
          basis,
          authoringSink: taskSink,
        }),
        taskId: "task-1",
        actor: seat,
        originAt: atMinute(3),
        receivedAt: atMinute(3),
      }),
    );
    await runtime.runPromise(
      repository.transitionTask({
        sink: taskSink,
        basis,
        taskId: "task-1",
        state: "completed",
        message: message(
          "task-update",
          "SECRET_OPERATOR_TRANSITION",
          "task-1",
        ),
        originAt: atMinute(4),
        receivedAt: atMinute(4),
      }),
    );
    await runtime.runPromise(
      repository.createRequest({
        sink: { canvasName, nodeId: "requests" },
        basis,
        request: {
          id: "request-1",
          state: "input-required",
          claimedBy: seat.seatId,
          history: [
            message("request-brief", "SECRET_REQUEST_BODY", "request-1"),
          ],
        },
        raisedBy: seat,
        originAt: atMinute(5),
        receivedAt: atMinute(5),
      }),
    );
    await runtime.runPromise(
      appendMailboxMessage(repository, basis, seat, {
        id: "message-1",
        text: "SECRET_MESSAGE_BODY",
        at: atMinute(6),
      }),
    );
    await runtime.runPromise(
      repository.publishArtifact({
        sink: { canvasName, nodeId: "artifacts" },
        basis,
        artifact: {
          artifactId: "artifact-1",
          name: `release-${"😀".repeat(100)}-notes.md`,
          parts: [{ kind: "text", text: "SECRET_ARTIFACT_BODY" }],
          task: { kind: "task", itemId: "task-1", sink: taskSink },
        },
        publishedBy: seat,
        originAt: atMinute(7),
        receivedAt: atMinute(7),
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
    const boardAuthor = {
      kind: "actor" as const,
      seatId: seat.seatId,
      nodeId: seat.nodeId,
      label: "Worker",
    };
    await runtime.runPromise(
      repository.createBoardTopic({
        sink: { canvasName, nodeId: "board" },
        basis,
        topic: {
          topicId: "topic-1",
          title: "Shipping notes",
          state: "open",
          openedBy: boardAuthor,
          openedAt: atMinute(9),
          postCount: 0,
          lastActivityAt: atMinute(9),
        },
        createdBy: boardAuthor,
        originAt: atMinute(9),
        receivedAt: atMinute(9),
      }),
    );
    await runtime.runPromise(
      repository.appendBoardPost({
        sink: { canvasName, nodeId: "board" },
        basis,
        post: {
          postId: "post-1",
          topicId: "topic-1",
          author: boardAuthor,
          parts: [{ kind: "text", text: "SECRET_BOARD_POST" }],
          position: 0,
          createdAt: atMinute(10),
        },
        createdBy: boardAuthor,
        originAt: atMinute(10),
        receivedAt: atMinute(10),
      }),
    );
    const operatorAuthor = {
      kind: "operator" as const,
      label: "Operator",
    };
    await runtime.runPromise(
      repository.createBoardTopic({
        sink: { canvasName, nodeId: "board" },
        basis,
        topic: {
          topicId: "operator-topic",
          title: "Operator-only note",
          state: "open",
          openedBy: operatorAuthor,
          openedAt: atMinute(11),
          postCount: 0,
          lastActivityAt: atMinute(11),
        },
        createdBy: operatorAuthor,
        originAt: atMinute(11),
        receivedAt: atMinute(11),
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
      "board.post.append",
      "board.topic.create",
      "delivery.accepted",
      "artifact.publish",
      "message.append",
      "request.create",
      "task.claim",
      "proposal.create",
    ]);
    expect(feed.lastOpAt).toBe(atMinute(10));
    expect(feed.coverage).toMatchObject({
      kind: "explicit-actor-only",
      includes: [
        "proposal.create",
        "task.claim",
        "request.create",
        "message.append",
        "artifact.publish",
        "delivery.accepted",
        "board.topic.create",
        "board.post.append",
      ],
      excludes: expect.arrayContaining(["task.describe", "task.transition"]),
    });
    expect(feed.operations).toEqual([
      expect.objectContaining({
        targetNodeId: "board",
        summary: { kind: "post", postId: "post-1", topicId: "topic-1" },
      }),
      expect.objectContaining({
        summary: { kind: "topic", topicId: "topic-1", title: "Shipping notes" },
      }),
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
        summary: {
          kind: "artifact",
          artifactId: "artifact-1",
          name: `release-${"😀".repeat(76)}`,
          taskId: "task-1",
        },
      }),
      expect.objectContaining({
        targetNodeId: "recipient",
        summary: { kind: "message", messageId: "message-1" },
      }),
      expect.objectContaining({
        summary: { kind: "request", requestId: "request-1" },
      }),
      expect.objectContaining({
        summary: { kind: "task", taskId: "task-1" },
      }),
      expect.objectContaining({
        summary: { kind: "proposal", proposalId: "proposal-1" },
      }),
    ]);
    const exposed = JSON.stringify(feed);
    for (const secret of [
      "SECRET_PROPOSAL_BODY",
      "SECRET_TASK_BODY",
      "SECRET_OPERATOR_TRANSITION",
      "SECRET_REQUEST_BODY",
      "SECRET_MESSAGE_BODY",
      "SECRET_ARTIFACT_BODY",
      "SECRET_BOARD_POST",
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
    const proposal = {
      id: "remote-proposal",
      state: "pending" as const,
      brief: message(
        "remote-proposal-brief",
        "SECRET_REMOTE_PROPOSAL",
        "remote-proposal",
      ),
      proposedBy: seat,
    };
    const proposalCommand = await remote.runtime.runPromise(
      remote.repository.enqueueRemoteCommand({
        targetInstallationId: commandCenterId,
        sink: { canvasName, nodeId: "tasks" },
        item: {
          kind: "proposal",
          itemId: proposal.id,
          sink: { canvasName, nodeId: "tasks" },
        },
        action: { operation: "proposal.create", proposal },
        originAt: atMinute(5),
        receivedAt: atMinute(5),
      }),
    );
    await commandCenter.runtime.runPromise(
      accept(
        commandCenter.repository,
        remoteId,
        [proposalCommand],
        atMinute(6),
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
        operation: "proposal.create",
        originAt: atMinute(5),
        appliedAt: atMinute(6),
        targetNodeId: "tasks",
        summary: { kind: "proposal", proposalId: "remote-proposal" },
      },
      {
        operation: "message.append",
        originAt: atMinute(1),
        appliedAt: atMinute(2),
        targetNodeId: "recipient",
        summary: { kind: "message", messageId: "remote-message" },
      },
    ]);
    expect(feed.lastOpAt).toBe(atMinute(6));
    expect(JSON.stringify(feed)).not.toContain("SECRET_REMOTE_MESSAGE");
    expect(JSON.stringify(feed)).not.toContain("SECRET_REJECTED_MESSAGE");
    expect(JSON.stringify(feed)).not.toContain("SECRET_REMOTE_PROPOSAL");
  });
});
