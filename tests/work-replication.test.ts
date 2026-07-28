import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Effect,
  Either,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  AuthorialIntentFactBasis,
  ProjectedIntentFactBasis,
  RouteCursor,
  WorkRecord,
  type WorkCommand as WorkCommandValue,
  type WorkRecord as WorkRecordValue,
} from "../src/shared/work-protocol";
import {
  workRecordContentSha256,
  WorkReplicationError,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import { stationProjectionContentSha256 } from "../src/main/vellum/station/repository";
import { compileStationPortfolioBody } from "../src/main/vellum/station/portfolio";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";

const observedAt = "2026-07-27T18:00:00.000Z";
const authorialBody = JSON.stringify({ nodes: [], edges: [] });
const authorialIntentSha256 = "a".repeat(64);
const authorialDocumentSha256 = createHash("sha256")
  .update(authorialBody, "utf8")
  .digest("hex");
const projectedBody = compileStationPortfolioBody(
  new Map([["factory", { nodes: [], edges: [] }]]),
  new Map(),
);
const projectedContentSha256 =
  stationProjectionContentSha256(projectedBody);
const authorialBasis = Schema.decodeUnknownSync(
  AuthorialIntentFactBasis,
)({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: authorialIntentSha256,
});
const projectedBasis = Schema.decodeUnknownSync(
  ProjectedIntentFactBasis,
)({
  kind: "projected-intent",
  generation: "1",
  contentSha256: projectedContentSha256,
});
const opened: Array<{
  readonly root: string;
  readonly dispose: () => Promise<void>;
}> = [];

afterEach(async () => {
  const closing = opened.splice(0);
  await Promise.all(closing.map(({ dispose }) => dispose()));
  await Promise.all(
    closing.map(({ root }) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const actor = (digit: string, nodeId = `actor-${digit}`) => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(
    `seat_${digit.repeat(64)}`,
  ),
  canvasName: "factory",
  nodeId,
});

const message = (
  messageId: string,
  role: "user" | "agent",
  text: string,
  taskId?: string,
) => ({
  messageId,
  role,
  parts: [{ kind: "text" as const, text }],
  ...(taskId === undefined ? {} : { taskId }),
  contextId: "factory",
});

const openInstallation = async (
  local: InstallationIdValue,
  peers: ReadonlyArray<InstallationIdValue>,
  role: "command-center" | "remote",
) => {
  const root = join(
    tmpdir(),
    `vellum-work-replication-v2-${local}-${randomUUID()}`,
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "vellum.db")),
    ),
  );
  opened.push({
    root,
    dispose: () => runtime.dispose(),
  });
  const repository = await runtime.runPromise(WorkRepository);
  const state = await runtime.runPromise(StateEngine);
  await runtime.runPromise(
    state.transaction("test.seed-installation", (writer) => {
      for (const known of new Set([local, ...peers])) {
        writer.run(
          `
            INSERT INTO station_known_installations(
              installation_id,
              registered_at
            ) VALUES (?, ?)
          `,
          [known, observedAt],
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
        [local, observedAt],
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
          ? [role, "local", null, null, observedAt]
          : [role, "remote", "remote", peers[0], observedAt],
      );
      writer.run(
        `
          INSERT INTO canvas_generations(
            generation,
            created_at,
            cause,
            intent_sha256,
            document_count
          ) VALUES (?, ?, ?, ?, 1)
        `,
        [
          authorialBasis.generation,
          observedAt,
          "test work replication basis",
          authorialBasis.contentSha256,
        ],
      );
      writer.run(
        `
          INSERT INTO canvas_generation_documents(
            generation,
            name,
            body,
            sha256,
            modified_at
          ) VALUES (?, 'factory', ?, ?, ?)
        `,
        [
          authorialBasis.generation,
          authorialBody,
          authorialDocumentSha256,
          observedAt,
        ],
      );
      writer.run(
        `
          INSERT INTO canvas_head(singleton, generation)
          VALUES (1, ?)
        `,
        [authorialBasis.generation],
      );
      writer.run(
        `
          INSERT INTO station_projection_versions(
            generation,
            content_sha256,
            source_canvas_generation,
            source_intent_sha256,
            body,
            created_at,
            received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          projectedBasis.generation,
          projectedBasis.contentSha256,
          authorialBasis.generation,
          authorialBasis.contentSha256,
          projectedBody,
          observedAt,
          observedAt,
        ],
      );
      writer.run(
        `
          INSERT INTO station_projection_head(
            singleton,
            generation,
            content_sha256
          ) VALUES (1, ?, ?)
        `,
        [
          projectedBasis.generation,
          projectedBasis.contentSha256,
        ],
      );
    }),
  );
  return {
    runtime,
    repository,
    state,
    basis: role === "command-center"
      ? authorialBasis
      : projectedBasis,
  };
};

const admitted = () => ({ _tag: "admitted" as const });

const commandBasis = (command: WorkCommandValue) => ({
  kind: "command" as const,
  command: command.id,
  commandSha256: command.contentSha256,
});

const accept = (
  repository: typeof WorkRepository.Service,
  senderInstallationId: InstallationIdValue,
  records: ReadonlyArray<WorkRecordValue>,
  options?: {
    readonly peerAcknowledgements?: Parameters<
      typeof repository.acceptRecords
    >[0]["peerAcknowledgements"];
    readonly authorizeCommand?: Parameters<
      typeof repository.acceptRecords
    >[0]["authorizeCommand"];
    readonly authorizeFact?: Parameters<
      typeof repository.acceptRecords
    >[0]["authorizeFact"];
    readonly admitResponse?: Parameters<
      typeof repository.acceptRecords
    >[0]["admitResponse"];
  },
) =>
  repository.acceptRecords({
    senderInstallationId,
    records,
    peerAcknowledgements: options?.peerAcknowledgements ?? [],
    receivedAt: observedAt,
    authorizeCommand: options?.authorizeCommand ?? admitted,
    authorizeFact: options?.authorizeFact ?? admitted,
    admitResponse: options?.admitResponse ?? admitted,
  });

const reseal = (
  candidate: WorkRecordValue,
): WorkRecordValue => {
  const {
    contentSha256: _contentSha256,
    originAt: _originAt,
    ...semantic
  } = candidate;
  return Schema.decodeUnknownSync(WorkRecord, {
    onExcessProperty: "error",
  })({
    ...candidate,
    contentSha256: workRecordContentSha256(
      semantic as Parameters<typeof workRecordContentSha256>[0],
    ),
  });
};

describe("WorkRepository v2 report reconciliation", () => {
  it("commits peer acknowledgement only with the inbound records it accepts", async () => {
    const cc = installation("cc-atomic-inbound");
    const remote = installation("remote-atomic-inbound");
    const commandCenter = await openInstallation(
      cc,
      [remote],
      "command-center",
    );
    const station = await openInstallation(remote, [cc], "remote");
    const sink = { canvasName: "factory", nodeId: "tasks" };
    const localFact = await commandCenter.runtime.runPromise(
      commandCenter.repository.createTask({
        sink,
        basis: commandCenter.basis,
        task: {
          id: "local-outbound",
          state: "submitted",
          history: [],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const acknowledgement = RouteCursor.make({
      eventHome: cc,
      entityHome: cc,
      through: localFact.record.id.seq,
    });
    const remoteCommand = await station.runtime.runPromise(
      station.repository.enqueueRemoteCommand({
        targetInstallationId: cc,
        sink,
        item: {
          kind: "task",
          itemId: "remote-created",
          sink,
        },
        action: {
          operation: "task.create",
          task: {
            id: "remote-created",
            state: "submitted",
            history: [],
          },
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const rejected = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [remoteCommand], {
        peerAcknowledgements: [acknowledgement],
        admitResponse: () => ({
          _tag: "rejected",
          message: "mandatory response is intentionally rejected",
        }),
      }).pipe(Effect.either),
    );
    expect(Either.isLeft(rejected)).toBe(true);
    if (Either.isLeft(rejected)) {
      expect(rejected.left).toMatchObject({
        reason: "response-capacity",
      });
    }
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.state.read(
          "test.peer-ack-rolled-back",
          (reader) =>
            reader.get<{ readonly count: number }>(
              "SELECT count(*) AS count FROM station_peer_ack_cursors",
            )!.count,
        ),
      ),
    ).toBe(0);
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.repository.readSnapshot(
            sink.canvasName,
            sink.nodeId,
          ),
        )
      ).tasks.items,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "remote-created" }),
      ]),
    );

    const accepted = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [remoteCommand], {
        peerAcknowledgements: [acknowledgement],
      }),
    );
    expect(accepted.emitted[0]).toMatchObject({
      recordType: "fact",
      basis: commandBasis(remoteCommand),
    });
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.state.read(
          "test.peer-ack-committed",
          (reader) =>
            reader.get<{
              readonly through_sequence: string;
            }>(
              `
                SELECT through_sequence
                FROM station_peer_ack_cursors
                WHERE peer_installation_id = ?
                  AND event_home = ?
                  AND entity_home = ?
              `,
              [remote, cc, cc],
            )?.through_sequence,
        ),
      ),
    ).toBe(acknowledgement.through);
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.repository.readSnapshot(
            sink.canvasName,
            sink.nodeId,
          ),
        )
      ).tasks.items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "remote-created" }),
      ]),
    );
  });

  it("preserves the exact sender through a Remote-to-CC mailbox command and fact", async () => {
    const cc = installation("cc-message-provenance");
    const remote = installation("remote-message-provenance");
    const commandCenter = await openInstallation(
      cc,
      [remote],
      "command-center",
    );
    const station = await openInstallation(remote, [cc], "remote");
    const inbox = { canvasName: "factory", nodeId: "cc-inbox" };
    const sender = actor("8", "remote-sender");
    const appended = message(
      "message-with-provenance",
      "agent",
      "I sent this",
    );

    const command = await station.runtime.runPromise(
      station.repository.enqueueRemoteCommand({
        targetInstallationId: cc,
        sink: inbox,
        item: {
          kind: "message",
          itemId: appended.messageId,
          sink: inbox,
        },
        action: {
          operation: "message.append",
          message: appended,
          sentBy: sender,
          destination: { kind: "mailbox" },
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(command.body).toEqual({
      operation: "message.append",
      message: appended,
      sentBy: sender,
      destination: { kind: "mailbox" },
    });

    const response = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [command]),
    );
    const [fact, disposition] = response.emitted;
    if (
      fact?.recordType !== "fact" ||
      fact.body.operation !== "message.append" ||
      disposition?.recordType !== "disposition" ||
      disposition.body.status !== "applied"
    ) {
      throw new Error("message command did not emit its fact and disposition");
    }
    expect(fact.body.sentBy).toEqual(sender);
    expect(fact.basis).toEqual(commandBasis(command));

    const changedSender = actor("9", "different-sender");
    const changedFact = reseal({
      ...fact,
      body: {
        ...fact.body,
        sentBy: changedSender,
      },
    });
    const changedDisposition = reseal({
      ...disposition,
      body: {
        ...disposition.body,
        factSha256: changedFact.contentSha256,
      },
    });
    const changedResponse = await station.runtime.runPromise(
      accept(
        station.repository,
        cc,
        [changedFact, changedDisposition],
      ).pipe(Effect.either),
    );
    expect(Either.isLeft(changedResponse)).toBe(true);
    if (Either.isLeft(changedResponse)) {
      expect(changedResponse.left).toMatchObject({
        reason: "causal-conflict",
      });
    }

    await station.runtime.runPromise(
      accept(station.repository, cc, response.emitted),
    );
    expect(
      await station.runtime.runPromise(
        station.state.read(
          "test.read-remote-mailbox-material",
          (reader) =>
            reader.get<{ readonly count: number }>(
              "SELECT count(*) AS count FROM work_messages",
            )!.count,
        ),
      ),
    ).toBe(0);
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.state.read(
          "test.read-command-message-sender",
          (reader) =>
            reader.get<{ readonly actor_seat_id: string }>(
              `
                SELECT actor_seat_id
                FROM work_messages
                WHERE canvas_name = ? AND node_id = ? AND message_id = ?
              `,
              [inbox.canvasName, inbox.nodeId, appended.messageId],
            )?.actor_seat_id,
        ),
      ),
    ).toBe(sender.seatId);
    expect(
      (await station.runtime.runPromise(
        station.repository.pendingCommands,
      ))[0],
    ).toMatchObject({ resolution: { status: "applied" } });
  });

  it("retains an exact CC message response on a Remote without materializing nonlocal thread state", async () => {
    const cc = installation("cc-thread-response");
    const remote = installation("remote-thread-response");
    const station = await openInstallation(remote, [cc], "remote");
    const sink = { canvasName: "factory", nodeId: "cc-tasks" };
    const sender = actor("7", "remote-thread-sender");
    const appended = message(
      "thread-response-message",
      "agent",
      "online note for the CC-owned task",
      "cc-task",
    );
    const command = await station.runtime.runPromise(
      station.repository.enqueueRemoteCommand({
        targetInstallationId: cc,
        sink,
        item: {
          kind: "message",
          itemId: appended.messageId,
          sink,
        },
        action: {
          operation: "message.append",
          message: appended,
          sentBy: sender,
          destination: { kind: "task", itemId: "cc-task" },
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const fact = reseal(
      Schema.decodeUnknownSync(WorkRecord, {
        onExcessProperty: "error",
      })({
        protocol: "vellum/work/v2",
        id: {
          route: { eventHome: cc, entityHome: cc },
          seq: "1",
        },
        recordType: "fact",
        basis: commandBasis(command),
        item: command.item,
        operation: "message.append",
        contentSha256: "0".repeat(64),
        originAt: observedAt,
        predecessor: command.predecessor,
        body: {
          operation: "message.append",
          message: appended,
          sentBy: sender,
          destination: { kind: "task", itemId: "cc-task" },
        },
      }),
    );
    if (
      fact.recordType !== "fact" ||
      fact.body.operation !== "message.append"
    ) {
      throw new Error("thread response fixture is not a fact");
    }
    const disposition = reseal(
      Schema.decodeUnknownSync(WorkRecord, {
        onExcessProperty: "error",
      })({
        protocol: "vellum/work/v2",
        id: {
          route: { eventHome: cc, entityHome: cc },
          seq: "2",
        },
        recordType: "disposition",
        item: command.item,
        operation: "message.append",
        contentSha256: "0".repeat(64),
        originAt: observedAt,
        body: {
          status: "applied",
          command: command.id,
          commandSha256: command.contentSha256,
          fact: fact.id,
          factSha256: fact.contentSha256,
        },
      }),
    );
    const forged = reseal({
      ...fact,
      body: {
        ...fact.body,
        sentBy: actor("6", "forged-thread-sender"),
      },
    });
    const denied = await station.runtime.runPromise(
      accept(station.repository, cc, [forged]).pipe(Effect.either),
    );
    expect(Either.isLeft(denied)).toBe(true);

    const accepted = await station.runtime.runPromise(
      accept(station.repository, cc, [fact, disposition]),
    );
    expect(accepted.acknowledge).toEqual([
      { eventHome: cc, entityHome: cc, through: "2" },
    ]);
    expect(
      await station.runtime.runPromise(
        station.state.read(
          "test.read-nonlocal-thread-residency",
          (reader) => ({
            cursor: reader.get<{ readonly through_sequence: string }>(
              `
                SELECT through_sequence
                FROM station_received_cursors
                WHERE event_home = ? AND entity_home = ?
              `,
              [cc, cc],
            )?.through_sequence,
            inbox: reader.get<{ readonly count: number }>(
              "SELECT count(*) AS count FROM work_messages",
            )!.count,
            threads: reader.get<{ readonly count: number }>(
              "SELECT count(*) AS count FROM work_task_messages",
            )!.count,
          }),
        ),
      ),
    ).toEqual({ cursor: "2", inbox: 0, threads: 0 });
    expect(
      (await station.runtime.runPromise(
        station.repository.pendingCommands,
      ))[0],
    ).toMatchObject({ resolution: { status: "applied" } });
  });

  it("materializes Remote-home task notes into the Command Center replica", async () => {
    const cc = installation("cc-thread-replica");
    const remote = installation("remote-thread-replica");
    const commandCenter = await openInstallation(
      cc,
      [remote],
      "command-center",
    );
    const station = await openInstallation(remote, [cc], "remote");
    const sink = { canvasName: "factory", nodeId: "remote-tasks" };
    const taskId = "remote-thread-task";
    const created = await station.runtime.runPromise(
      station.repository.createTask({
        sink,
        basis: station.basis,
        task: {
          id: taskId,
          state: "submitted",
          history: [
            message("remote-thread-brief", "user", "do it", taskId),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [created.record]),
    );
    const note = message(
      "remote-thread-note",
      "agent",
      "progress",
      taskId,
    );
    const appended = await station.runtime.runPromise(
      station.repository.appendMessage({
        sink,
        basis: station.basis,
        message: note,
        sentBy: actor("5", "remote-note-sender"),
        destination: { kind: "task", itemId: taskId },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [appended.record]),
    );

    const remoteHistory = (
      await station.runtime.runPromise(
        station.repository.readSnapshot(sink.canvasName, sink.nodeId),
      )
    ).tasks.items[0]!.history;
    const commandCenterHistory = (
      await commandCenter.runtime.runPromise(
        commandCenter.repository.readSnapshot(
          sink.canvasName,
          sink.nodeId,
        ),
      )
    ).tasks.items[0]!.history;
    expect(remoteHistory).toEqual([created.value.history[0], note]);
    expect(commandCenterHistory).toEqual(remoteHistory);
  });

  it("adopts one CC task on a Remote and integrates returned facts rather than replaying the command", async () => {
    const cc = installation("cc-first-adoption");
    const remote = installation("remote-first-adoption");
    const commandCenter = await openInstallation(
      cc,
      [remote],
      "command-center",
    );
    const station = await openInstallation(remote, [cc], "remote");
    const sink = { canvasName: "factory", nodeId: "shared-tasks" };
    const worker = actor("a", "remote-worker");

    const created = await commandCenter.runtime.runPromise(
      commandCenter.repository.createTask({
        sink,
        basis: commandCenter.basis,
        task: {
          id: "task-first-adoption",
          state: "submitted",
          history: [
            message(
              "brief-first-adoption",
              "user",
              "ship the beta",
              "task-first-adoption",
            ),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const command = await commandCenter.runtime.runPromise(
      commandCenter.repository.reserveRemoteTaskClaim({
        targetInstallationId: remote,
        sink,
        taskId: created.value.id,
        actor: worker,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const capacityDenied = await station.runtime.runPromise(
      accept(station.repository, cc, [command], {
        admitResponse: () => ({
          _tag: "rejected",
          message: "mandatory response exceeds ReportBatch capacity",
        }),
      }).pipe(Effect.either),
    );
    expect(Either.isLeft(capacityDenied)).toBe(true);
    if (Either.isLeft(capacityDenied)) {
      expect(capacityDenied.left).toMatchObject({
        reason: "response-capacity",
      });
    }
    expect(
      (
        await station.runtime.runPromise(
          station.repository.readSnapshot(
            sink.canvasName,
            sink.nodeId,
          ),
        )
      ).tasks.items,
    ).toEqual([]);

    const remoteResult = await station.runtime.runPromise(
      accept(station.repository, cc, [command]),
    );
    expect(remoteResult).toMatchObject({
      accepted: 1,
      idempotent: 0,
      rejected: 0,
      acknowledge: [
        { eventHome: cc, entityHome: remote, through: "1" },
      ],
    });
    expect(remoteResult.emitted.map((record) => record.recordType)).toEqual([
      "fact",
      "disposition",
    ]);
    const [claimFact, applied] = remoteResult.emitted;
    expect(claimFact).toMatchObject({
      recordType: "fact",
      operation: "task.claim",
      predecessor: null,
      id: {
        route: { eventHome: remote, entityHome: remote },
        seq: "1",
      },
      body: {
        previousHome: cc,
        claimedBy: worker,
        task: { state: "working", claimedBy: worker.seatId },
      },
      basis: commandBasis(command),
    });
    expect(applied).toMatchObject({
      recordType: "disposition",
      id: {
        route: { eventHome: remote, entityHome: remote },
        seq: "2",
      },
      body: {
        status: "applied",
        command: command.id,
        commandSha256: command.contentSha256,
      },
    });
    expect(
      await station.runtime.runPromise(
        station.repository.itemHome(
          "task",
          sink.canvasName,
          sink.nodeId,
          created.value.id,
        ),
      ),
    ).toBe(remote);

    const integrated = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, remoteResult.emitted),
    );
    expect(integrated).toMatchObject({
      accepted: 2,
      idempotent: 0,
      rejected: 0,
      acknowledge: [
        { eventHome: remote, entityHome: remote, through: "2" },
      ],
      emitted: [],
    });
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.repository.readSnapshot(
            sink.canvasName,
            sink.nodeId,
          ),
        )
      ).tasks.items[0],
    ).toMatchObject({
      id: created.value.id,
      state: "working",
      claimedBy: worker.seatId,
    });
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.repository.itemHome(
          "task",
          sink.canvasName,
          sink.nodeId,
          created.value.id,
        ),
      ),
    ).toBe(remote);
    expect(
      (await commandCenter.runtime.runPromise(
        commandCenter.repository.pendingCommands,
      ))[0],
    ).toMatchObject({ resolution: { status: "applied" } });

    const completed = await station.runtime.runPromise(
      station.repository.transitionTask({
        sink,
        basis: station.basis,
        taskId: created.value.id,
        state: "completed",
        message: message(
          "done-first-adoption",
          "agent",
          "done",
          created.value.id,
        ),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(completed.record.id.seq).toBe("3");
    expect(completed.record.predecessor).toEqual(claimFact!.id);
    const wrongPredecessor = reseal({
      ...completed.record,
      predecessor: remoteResult.emitted[1]!.id,
    });
    const causalFailure = await commandCenter.runtime.runPromise(
      accept(
        commandCenter.repository,
        remote,
        [wrongPredecessor],
      ).pipe(Effect.either),
    );
    expect(Either.isLeft(causalFailure)).toBe(true);
    if (Either.isLeft(causalFailure)) {
      expect(causalFailure.left).toMatchObject({
        reason: "causal-conflict",
      });
    }
    await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [completed.record]),
    );
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.repository.readSnapshot(
            sink.canvasName,
            sink.nodeId,
          ),
        )
      ).tasks.items[0]?.state,
    ).toBe("completed");
  });

  it("replays the exact durable fact/disposition and commits rejections as outcomes", async () => {
    const cc = installation("cc-replay");
    const remote = installation("remote-replay");
    const commandCenter = await openInstallation(
      cc,
      [remote],
      "command-center",
    );
    const station = await openInstallation(remote, [cc], "remote");
    const sink = { canvasName: "factory", nodeId: "replay-tasks" };
    const worker = actor("b");

    const created = await commandCenter.runtime.runPromise(
      commandCenter.repository.createTask({
        sink,
        basis: commandCenter.basis,
        task: {
          id: "task-replay",
          state: "submitted",
          history: [
            message("brief-replay", "user", "retry me", "task-replay"),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const command = await commandCenter.runtime.runPromise(
      commandCenter.repository.reserveRemoteTaskClaim({
        targetInstallationId: remote,
        sink,
        taskId: created.value.id,
        actor: worker,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const first = await station.runtime.runPromise(
      accept(station.repository, cc, [command], {
        authorizeCommand: () => ({
          _tag: "rejected",
          reason: "capability-denied",
          message: "projection edge was revoked",
        }),
      }),
    );
    expect(first).toMatchObject({
      accepted: 0,
      rejected: 1,
      idempotent: 0,
    });
    expect(first.emitted).toHaveLength(1);
    expect(first.emitted[0]).toMatchObject({
      recordType: "disposition",
      body: {
        status: "rejected",
        reason: "capability-denied",
        command: command.id,
      },
    });

    const replay = await station.runtime.runPromise(
      accept(station.repository, cc, [command]),
    );
    expect(replay).toMatchObject({
      accepted: 0,
      rejected: 0,
      idempotent: 1,
      acknowledge: [
        { eventHome: cc, entityHome: remote, through: "1" },
      ],
    });
    expect(replay.emitted).toEqual(first.emitted);

    await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, first.emitted),
    );
    const source = (
      await commandCenter.runtime.runPromise(
        commandCenter.repository.readSnapshot(
          sink.canvasName,
          sink.nodeId,
        ),
      )
    ).tasks.items[0]!;
    expect(source.state).toBe("submitted");
    expect(source.claimedBy).toBeUndefined();
    expect(
      (await commandCenter.runtime.runPromise(
        commandCenter.repository.pendingCommands,
      ))[0],
    ).toMatchObject({ resolution: { status: "rejected" } });
  });

  it("rolls back gaps, hash conflicts, fact denial, and false local authority without advancing a cursor", async () => {
    const cc = installation("cc-integrity");
    const remote = installation("remote-integrity");
    const impostor = installation("other-known-installation");
    const commandCenter = await openInstallation(
      cc,
      [remote, impostor],
      "command-center",
    );
    const station = await openInstallation(
      remote,
      [cc, impostor],
      "remote",
    );
    const other = await openInstallation(
      impostor,
      [cc, remote],
      "remote",
    );
    const sink = { canvasName: "factory", nodeId: "integrity-tasks" };
    const worker = actor("c");

    const created = await commandCenter.runtime.runPromise(
      commandCenter.repository.createTask({
        sink,
        basis: commandCenter.basis,
        task: {
          id: "task-integrity",
          state: "submitted",
          history: [
            message(
              "brief-integrity",
              "user",
              "protect me",
              "task-integrity",
            ),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const command = await commandCenter.runtime.runPromise(
      commandCenter.repository.reserveRemoteTaskClaim({
        targetInstallationId: remote,
        sink,
        taskId: created.value.id,
        actor: worker,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const gap = reseal({
      ...command,
      id: { ...command.id, seq: "2" as typeof command.id.seq },
    });
    const gapResult = await station.runtime.runPromise(
      accept(station.repository, cc, [gap]).pipe(Effect.either),
    );
    expect(Either.isLeft(gapResult)).toBe(true);
    if (Either.isLeft(gapResult)) {
      expect(gapResult.left).toMatchObject({ reason: "sequence-gap" });
    }

    const falseAuthority = await other.runtime.runPromise(
      accept(other.repository, cc, [command]).pipe(Effect.either),
    );
    expect(Either.isLeft(falseAuthority)).toBe(true);
    if (Either.isLeft(falseAuthority)) {
      expect(falseAuthority.left).toMatchObject({
        reason: "direction-mismatch",
      });
    }

    const badHash = {
      ...command,
      contentSha256: "f".repeat(64) as typeof command.contentSha256,
    };
    const hashResult = await station.runtime.runPromise(
      accept(station.repository, cc, [badHash]).pipe(Effect.either),
    );
    expect(Either.isLeft(hashResult)).toBe(true);
    if (Either.isLeft(hashResult)) {
      expect(hashResult.left).toMatchObject({ reason: "integrity" });
    }

    const remoteResult = await station.runtime.runPromise(
      accept(station.repository, cc, [command]),
    );
    expect(remoteResult.acknowledge).toEqual([
      { eventHome: cc, entityHome: remote, through: "1" },
    ]);
    const denied = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, remoteResult.emitted, {
        authorizeFact: () => ({
          _tag: "rejected",
          reason: "locality-mismatch",
          message: "projection no longer admits this fact",
        }),
      }).pipe(Effect.either),
    );
    expect(Either.isLeft(denied)).toBe(true);
    if (Either.isLeft(denied)) {
      expect(denied.left).toMatchObject({ reason: "causal-conflict" });
    }
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.repository.readSnapshot(
            sink.canvasName,
            sink.nodeId,
          ),
        )
      ).tasks.items[0]?.state,
    ).toBe("submitted");
    expect(
      (await commandCenter.runtime.runPromise(
        commandCenter.repository.pendingCommands,
      ))[0]?.resolution,
    ).toBeUndefined();

    const admittedResult = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, remoteResult.emitted),
    );
    expect(admittedResult.acknowledge).toEqual([
      { eventHome: remote, entityHome: remote, through: "2" },
    ]);

    if (command.body.operation !== "task.claim") {
      throw new Error("test claim command narrowed incorrectly");
    }
    const conflicting = reseal({
      ...command,
      body: {
        ...command.body,
        sourceTask: {
          ...command.body.sourceTask,
          metadata: { conflicting: true },
        },
      },
    });
    const conflict = await station.runtime.runPromise(
      accept(station.repository, cc, [conflicting]).pipe(Effect.either),
    );
    expect(Either.isLeft(conflict)).toBe(true);
    if (Either.isLeft(conflict)) {
      expect(conflict.left).toBeInstanceOf(WorkReplicationError);
      expect(conflict.left).toMatchObject({
        reason: "identity-conflict",
      });
    }
  });

  it("round-trips Remote request resolution and exact artifact task provenance", async () => {
    const cc = installation("cc-remote-facts");
    const remote = installation("remote-facts");
    const commandCenter = await openInstallation(
      cc,
      [remote],
      "command-center",
    );
    const station = await openInstallation(remote, [cc], "remote");
    const requester = actor("d", "requester");
    const taskClaimant = actor("e", "artifact-task-worker");
    const artifactPublisher = actor("f", "artifact-publisher");
    const requestSink = { canvasName: "factory", nodeId: "requests" };
    const taskSink = { canvasName: "factory", nodeId: "artifact-tasks" };
    const artifactSink = { canvasName: "factory", nodeId: "artifacts" };
    const inbox = { canvasName: "factory", nodeId: "cc-mail" };

    const request = await station.runtime.runPromise(
      station.repository.createRequest({
        sink: requestSink,
        basis: station.basis,
        raisedBy: requester,
        request: {
          id: "request-remote",
          state: "input-required",
          claimedBy: requester.seatId,
          history: [
            message(
              "request-remote-brief",
              "agent",
              "Approve deployment?",
              "request-remote",
            ),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const receivedRequest = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [request.record]),
    );
    expect(receivedRequest.acknowledge).toEqual([
      { eventHome: remote, entityHome: remote, through: "1" },
    ]);

    const resolve = await commandCenter.runtime.runPromise(
      commandCenter.repository.enqueueRemoteCommand({
        targetInstallationId: remote,
        sink: requestSink,
        item: {
          kind: "request",
          itemId: request.value.id,
          sink: requestSink,
        },
        action: {
          operation: "request.resolve",
          requestId: request.value.id,
          response: "Approved",
          disposition: "completed",
          message: message(
            "request-remote-answer",
            "user",
            "Approved",
            request.value.id,
          ),
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(resolve.predecessor).toEqual(request.record.id);

    const remoteResolution = await station.runtime.runPromise(
      accept(station.repository, cc, [resolve]),
    );
    expect(remoteResolution).toMatchObject({
      accepted: 1,
      acknowledge: [
        { eventHome: cc, entityHome: remote, through: "1" },
      ],
    });
    expect(remoteResolution.emitted.map((record) => record.id.seq)).toEqual([
      "2",
      "3",
    ]);
    expect(remoteResolution.emitted[0]).toMatchObject({
      recordType: "fact",
      basis: commandBasis(resolve),
    });
    await commandCenter.runtime.runPromise(
      accept(
        commandCenter.repository,
        remote,
        remoteResolution.emitted,
      ),
    );
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.repository.readSnapshot(
            requestSink.canvasName,
            requestSink.nodeId,
          ),
        )
      ).requests.items[0],
    ).toMatchObject({
      state: "completed",
      claimedBy: requester.seatId,
      response: "Approved",
    });

    const taskCreated = await station.runtime.runPromise(
      station.repository.createTask({
        sink: taskSink,
        basis: station.basis,
        task: {
          id: "artifact-source-task",
          state: "submitted",
          history: [
            message(
              "artifact-source-brief",
              "user",
              "produce remote proof",
              "artifact-source-task",
            ),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const taskClaimed = await station.runtime.runPromise(
      station.repository.claimLocalTask({
        sink: taskSink,
        basis: station.basis,
        taskId: taskCreated.value.id,
        actor: taskClaimant,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const task = {
      kind: "task" as const,
      itemId: taskClaimed.value.id,
      sink: taskSink,
    };
    const artifact = await station.runtime.runPromise(
      station.repository.publishArtifact({
        sink: artifactSink,
        basis: station.basis,
        publishedBy: artifactPublisher,
        artifact: {
          artifactId: "artifact-remote",
          name: "remote proof",
          parts: [{ kind: "text", text: "proof" }],
          task,
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(artifact.record.id.seq).toBe("6");
    const artifactReport = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [
        taskCreated.record,
        taskClaimed.record,
        artifact.record,
      ]),
    );
    expect(artifactReport.acknowledge).toEqual([
      { eventHome: remote, entityHome: remote, through: "6" },
    ]);
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.repository.readSnapshot(
            artifactSink.canvasName,
            artifactSink.nodeId,
          ),
        )
      ).artifacts.items[0],
    ).toEqual(artifact.value);

    if (artifact.record.body.operation !== "artifact.publish") {
      throw new Error("artifact fixture did not produce an artifact fact");
    }
    const forgedArtifact = reseal({
      ...artifact.record,
      id: {
        ...artifact.record.id,
        seq: "7" as typeof artifact.record.id.seq,
      },
      item: {
        ...artifact.record.item,
        itemId: "artifact-forged-missing-task",
      },
      body: {
        ...artifact.record.body,
        artifact: {
          ...artifact.record.body.artifact,
          artifactId: "artifact-forged-missing-task",
          task: {
            ...task,
            itemId: "missing-task",
          },
        },
      },
    });
    const deniedArtifact = await commandCenter.runtime.runPromise(
      accept(
        commandCenter.repository,
        remote,
        [forgedArtifact],
      ).pipe(Effect.either),
    );
    expect(Either.isLeft(deniedArtifact)).toBe(true);
    if (Either.isLeft(deniedArtifact)) {
      expect(deniedArtifact.left).toMatchObject({
        reason: "causal-conflict",
      });
    }
    expect(
      await commandCenter.runtime.runPromise(
        commandCenter.state.read(
          "test.read-denied-artifact-reference",
          (reader) => ({
            cursor: reader.get<{ readonly through_sequence: string }>(
              `
                SELECT through_sequence
                FROM station_received_cursors
                WHERE event_home = ? AND entity_home = ?
              `,
              [remote, remote],
            )?.through_sequence,
            forgedEvents: reader.get<{ readonly count: number }>(
              `
                SELECT count(*) AS count
                FROM work_events
                WHERE event_home = ? AND entity_home = ? AND seq = '7'
              `,
              [remote, remote],
            )!.count,
            artifacts: reader.get<{ readonly count: number }>(
              "SELECT count(*) AS count FROM work_artifacts",
            )!.count,
          }),
        ),
      ),
    ).toEqual({
      cursor: "6",
      forgedEvents: 0,
      artifacts: 1,
    });

    const deniedMail = await station.runtime.runPromise(
      station.repository
        .appendMessage({
          sink: inbox,
          basis: station.basis,
          message: message("remote-mail", "agent", "must stay CC-homed"),
          sentBy: requester,
          destination: { kind: "mailbox" },
          originAt: observedAt,
          receivedAt: observedAt,
        })
        .pipe(Effect.either),
    );
    expect(Either.isLeft(deniedMail)).toBe(true);
    expect(
      await station.runtime.runPromise(
        station.state.read(
          "test.read-denied-remote-mail",
          (reader) => ({
            records: reader.get<{ readonly count: number }>(
              `
                SELECT count(*) AS count
                FROM work_events
                WHERE item_kind = 'message'
                  AND item_id = 'remote-mail'
              `,
            )!.count,
            material: reader.get<{ readonly count: number }>(
              `
                SELECT count(*) AS count
                FROM work_messages
                WHERE canvas_name = ?
                  AND node_id = ?
                  AND message_id = 'remote-mail'
              `,
              [inbox.canvasName, inbox.nodeId],
            )!.count,
          }),
        ),
      ),
    ).toEqual({ records: 0, material: 0 });

    expect(
      (await commandCenter.runtime.runPromise(
        commandCenter.repository.pendingCommands,
      ))[0],
    ).toMatchObject({ resolution: { status: "applied" } });
  });
});
