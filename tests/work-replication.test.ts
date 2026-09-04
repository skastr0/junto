import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Effect,
  Result,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  AuthorialIntentFactBasis,
  ProjectedIntentFactBasis,
  RouteCursor,
  WorkRecord,
  type IntentFactBasis as IntentFactBasisValue,
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
import {
  authorialMaterialForTest,
  authorialTaskTopologyCapabilityForTest,
  currentProjectedTaskTopologyCapabilityForTest,
  retainedProjectedTaskTopologyCapabilityForTest,
} from "./helpers/task-topology-authority";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";

const observedAt = "2026-07-27T18:00:00.000Z";
const fixtureTaskSinkNodeIds: ReadonlyArray<string> = [
  "tasks",
  "remote-tasks",
  "cc-tasks",
  "shared-tasks",
  "replay-tasks",
  "integrity-tasks",
  "artifact-tasks",
];
const fixtureTaskNode = (
  id: string,
  index: number,
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  x: 0,
  y: index * 120,
  width: 240,
  height: 100,
  text: id,
  ether: { entity: { kind: "task" } },
});
const fixtureTopology: CanvasDoc = {
  nodes: fixtureTaskSinkNodeIds.map(fixtureTaskNode),
  edges: [],
};
const authorialBody = serializeCanvas(fixtureTopology);
const authorialIntentSha256 = authorialMaterialForTest({
  generation: "1",
  documents: new Map([
    ["factory", { document: fixtureTopology, rawBody: authorialBody }],
  ]),
}).intentSha256;
const projectedBody = compileStationPortfolioBody(
  new Map([["factory", fixtureTopology]]),
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

const dependencyScope = (
  sink: { readonly canvasName: string; readonly nodeId: string },
  basis: IntentFactBasisValue,
) =>
  basis.kind === "authorial-intent"
    ? authorialTaskTopologyCapabilityForTest({
        basis,
        sink,
        document: fixtureTopology,
        rawBody: authorialBody,
      })
    : currentProjectedTaskTopologyCapabilityForTest({
        basis,
        sink,
        rawBody: projectedBody,
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
    `vellum-command-work-replication-v2-${local}-${randomUUID()}`,
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "vellum-command.db")),
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
      seedCanvasAuthority(writer, {
        generation: authorialBasis.generation,
        documents: new Map([["factory", fixtureTopology]]),
        at: observedAt,
      });
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
const admittedWithTaskTopology = (
  taskDependencyScope: ReturnType<typeof dependencyScope>,
) => ({ _tag: "admitted" as const, taskDependencyScope });
const retainedDependencyScope = (
  sink: { readonly canvasName: string; readonly nodeId: string },
) => retainedProjectedTaskTopologyCapabilityForTest({
  basis: projectedBasis,
  sink,
  rawBody: projectedBody,
});

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
        dependencyScope: dependencyScope(sink, commandCenter.basis),
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
        authorizeCommand: () => admittedWithTaskTopology(
          dependencyScope(sink, commandCenter.basis),
        ),
        admitResponse: () => ({
          _tag: "rejected",
          message: "mandatory response is intentionally rejected",
        }),
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(rejected)).toBe(true);
    if (Result.isFailure(rejected)) {
      expect(rejected.failure).toMatchObject({
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
        authorizeCommand: () => admittedWithTaskTopology(
          dependencyScope(sink, commandCenter.basis),
        ),
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
    const decoyMessage = message(
      "message-decoy-command",
      "agent",
      "do not correlate me",
    );
    const decoyCommand = await station.runtime.runPromise(
      station.repository.enqueueRemoteCommand({
        targetInstallationId: cc,
        sink: inbox,
        item: {
          kind: "message",
          itemId: decoyMessage.messageId,
          sink: inbox,
        },
        action: {
          operation: "message.append",
          message: decoyMessage,
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

    const wrongCommandBasis = reseal({
      ...fact,
      basis: {
        kind: "command" as const,
        command: decoyCommand.id,
        commandSha256: decoyCommand.contentSha256,
      },
    });
    const wrongCommandResult = await station.runtime.runPromise(
      accept(
        station.repository,
        cc,
        [wrongCommandBasis],
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(wrongCommandResult)).toBe(true);
    if (Result.isFailure(wrongCommandResult)) {
      expect(wrongCommandResult.failure).toMatchObject({
        reason: "causal-conflict",
      });
    }

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
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(changedResponse)).toBe(true);
    if (Result.isFailure(changedResponse)) {
      expect(changedResponse.failure).toMatchObject({
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
      accept(station.repository, cc, [forged]).pipe(Effect.result),
    );
    expect(Result.isFailure(denied)).toBe(true);

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
        dependencyScope: dependencyScope(sink, station.basis),
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
      accept(commandCenter.repository, remote, [created.record], {
        authorizeFact: () => admittedWithTaskTopology(
          retainedDependencyScope(sink),
        ),
      }),
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
        dependencyScope: dependencyScope(sink, commandCenter.basis),
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
        basis: commandCenter.basis,
        dependencyScope: dependencyScope(sink, commandCenter.basis),
        taskId: created.value.id,
        actor: worker,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const decoyTask = await commandCenter.runtime.runPromise(
      commandCenter.repository.createTask({
        sink,
        basis: commandCenter.basis,
        dependencyScope: dependencyScope(sink, commandCenter.basis),
        task: {
          id: "task-decoy-adoption",
          state: "submitted",
          history: [
            message(
              "brief-decoy-adoption",
              "user",
              "do not correlate me",
              "task-decoy-adoption",
            ),
          ],
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const decoyCommand = await commandCenter.runtime.runPromise(
      commandCenter.repository.reserveRemoteTaskClaim({
        targetInstallationId: remote,
        sink,
        basis: commandCenter.basis,
        dependencyScope: dependencyScope(sink, commandCenter.basis),
        taskId: decoyTask.value.id,
        actor: actor("b", "remote-decoy-worker"),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const capacityDenied = await station.runtime.runPromise(
      accept(station.repository, cc, [command], {
        authorizeCommand: () => admittedWithTaskTopology(
          dependencyScope(sink, station.basis),
        ),
        admitResponse: () => ({
          _tag: "rejected",
          message: "mandatory response exceeds ReportBatch capacity",
        }),
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(capacityDenied)).toBe(true);
    if (Result.isFailure(capacityDenied)) {
      expect(capacityDenied.failure).toMatchObject({
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
      accept(station.repository, cc, [command], {
        authorizeCommand: () => admittedWithTaskTopology(
          dependencyScope(sink, station.basis),
        ),
      }),
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

    if (claimFact?.recordType !== "fact") {
      throw new Error("claim command did not emit a fact");
    }
    const wrongCommandBasis = reseal({
      ...claimFact,
      basis: {
        kind: "command" as const,
        command: decoyCommand.id,
        commandSha256: decoyCommand.contentSha256,
      },
    });
    const wrongCommandResult = await commandCenter.runtime.runPromise(
      accept(
        commandCenter.repository,
        remote,
        [wrongCommandBasis],
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(wrongCommandResult)).toBe(true);
    if (Result.isFailure(wrongCommandResult)) {
      expect(wrongCommandResult.failure).toMatchObject({
        reason: "causal-conflict",
      });
    }
    const sourceAfterWrongBasis = (
      await commandCenter.runtime.runPromise(
        commandCenter.repository.readSnapshot(
          sink.canvasName,
          sink.nodeId,
        ),
      )
    ).tasks.items.find((task) => task.id === created.value.id);
    expect(sourceAfterWrongBasis).toMatchObject({
      id: created.value.id,
      state: "submitted",
    });
    expect(sourceAfterWrongBasis?.claimedBy).toBeUndefined();
    expect(
      (await commandCenter.runtime.runPromise(
        commandCenter.repository.pendingCommands,
      ))[0]?.resolution,
    ).toBeUndefined();

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
      ).tasks.items.find((task) => task.id === created.value.id),
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
      )).find((pending) =>
        pending.command.id.route.eventHome === command.id.route.eventHome &&
        pending.command.id.route.entityHome ===
          command.id.route.entityHome &&
        pending.command.id.seq === command.id.seq
      ),
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
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(causalFailure)).toBe(true);
    if (Result.isFailure(causalFailure)) {
      expect(causalFailure.failure).toMatchObject({
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
      ).tasks.items.find((task) => task.id === created.value.id)?.state,
    ).toBe("completed");

    const qaRejected = await station.runtime.runPromise(
      station.repository.transitionTask({
        sink,
        basis: station.basis,
        taskId: created.value.id,
        state: "submitted",
        message: message(
          "qa-reject-first-adoption",
          "user",
          "The completion receipt is missing.",
          created.value.id,
        ),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [qaRejected.record]),
    );
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.repository.readSnapshot(
            sink.canvasName,
            sink.nodeId,
          ),
        )
      ).tasks.items.find((task) => task.id === created.value.id),
    ).toMatchObject({
      id: created.value.id,
      state: "submitted",
      metadata: { rejectedTimes: 1 },
    });
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
        dependencyScope: dependencyScope(sink, commandCenter.basis),
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
        basis: commandCenter.basis,
        dependencyScope: dependencyScope(sink, commandCenter.basis),
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
        dependencyScope: dependencyScope(sink, commandCenter.basis),
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
        basis: commandCenter.basis,
        dependencyScope: dependencyScope(sink, commandCenter.basis),
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
      accept(station.repository, cc, [gap]).pipe(Effect.result),
    );
    expect(Result.isFailure(gapResult)).toBe(true);
    if (Result.isFailure(gapResult)) {
      expect(gapResult.failure).toMatchObject({ reason: "sequence-gap" });
    }

    const falseAuthority = await other.runtime.runPromise(
      accept(other.repository, cc, [command]).pipe(Effect.result),
    );
    expect(Result.isFailure(falseAuthority)).toBe(true);
    if (Result.isFailure(falseAuthority)) {
      expect(falseAuthority.failure).toMatchObject({
        reason: "direction-mismatch",
      });
    }

    const badHash = {
      ...command,
      contentSha256: "f".repeat(64) as typeof command.contentSha256,
    };
    const hashResult = await station.runtime.runPromise(
      accept(station.repository, cc, [badHash]).pipe(Effect.result),
    );
    expect(Result.isFailure(hashResult)).toBe(true);
    if (Result.isFailure(hashResult)) {
      expect(hashResult.failure).toMatchObject({ reason: "integrity" });
    }

    const remoteResult = await station.runtime.runPromise(
      accept(station.repository, cc, [command], {
        authorizeCommand: () => admittedWithTaskTopology(
          dependencyScope(sink, station.basis),
        ),
      }),
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
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(denied)).toBe(true);
    if (Result.isFailure(denied)) {
      expect(denied.failure).toMatchObject({ reason: "causal-conflict" });
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
      accept(station.repository, cc, [conflicting]).pipe(Effect.result),
    );
    expect(Result.isFailure(conflict)).toBe(true);
    if (Result.isFailure(conflict)) {
      expect(conflict.failure).toBeInstanceOf(WorkReplicationError);
      expect(conflict.failure).toMatchObject({
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
    const resolutionFact = remoteResolution.emitted[0];
    if (
      resolutionFact?.recordType !== "fact" ||
      resolutionFact.body.operation !== "request.resolve"
    ) {
      throw new Error("request resolution did not emit its fact");
    }
    const uncommandedHistory = reseal({
      ...resolutionFact,
      body: {
        ...resolutionFact.body,
        request: {
          ...resolutionFact.body.request,
          history: [
            ...resolutionFact.body.request.history,
            message(
              "uncommanded-request-history",
              "user",
              "this was not in the command",
              request.value.id,
            ),
          ],
        },
      },
    });
    const deniedHistory = await commandCenter.runtime.runPromise(
      accept(
        commandCenter.repository,
        remote,
        [uncommandedHistory],
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(deniedHistory)).toBe(true);
    if (Result.isFailure(deniedHistory)) {
      expect(deniedHistory.failure).toMatchObject({
        reason: "causal-conflict",
      });
    }
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
        dependencyScope: dependencyScope(taskSink, station.basis),
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
        dependencyScope: dependencyScope(taskSink, station.basis),
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
      ], {
        authorizeFact: (fact) =>
          fact.item.kind === "task"
            ? admittedWithTaskTopology(retainedDependencyScope(fact.item.sink))
            : admitted(),
      }),
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
      // Projection-only publisher stamp (mirrors mailbox deliveredAt/readAt).
    ).toEqual({
      ...artifact.value,
      metadata: { publishedBySeatId: artifactPublisher.seatId },
    });

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
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(deniedArtifact)).toBe(true);
    if (Result.isFailure(deniedArtifact)) {
      expect(deniedArtifact.failure).toMatchObject({
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
        .pipe(Effect.result),
    );
    expect(Result.isFailure(deniedMail)).toBe(true);
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

  it("keeps board material on Command Center only (mailbox residency)", async () => {
    const cc = installation("cc-board-home");
    const remote = installation("remote-board-home");
    const commandCenter = await openInstallation(
      cc,
      [remote],
      "command-center",
    );
    const station = await openInstallation(remote, [cc], "remote");
    const sink = { canvasName: "factory", nodeId: "board" };
    const createdBy = {
      kind: "actor" as const,
      seatId: actor("b", "remote-board-agent").seatId,
      nodeId: "remote-board-agent",
      label: "remote-board-agent",
    };
    const topic = {
      topicId: "fleet-topic-1",
      title: "CC-homed board",
      state: "open" as const,
      openedBy: createdBy,
      openedAt: observedAt,
      postCount: 0,
      lastActivityAt: observedAt,
    };
    const topicCommand = await station.runtime.runPromise(
      station.repository.enqueueRemoteCommand({
        targetInstallationId: cc,
        sink,
        item: { kind: "topic", itemId: topic.topicId, sink },
        action: {
          operation: "board.topic.create",
          topic,
          createdBy,
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const topicAccepted = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [topicCommand]),
    );
    expect(topicAccepted.emitted.length).toBeGreaterThanOrEqual(2);
    expect(
      (
        await commandCenter.runtime.runPromise(
          commandCenter.repository.readSnapshot(sink.canvasName, sink.nodeId),
        )
      ).board.topics.map((t) => t.topicId),
    ).toContain(topic.topicId);

    const topicReturned = await station.runtime.runPromise(
      accept(station.repository, cc, topicAccepted.emitted),
    );
    expect(topicReturned.accepted).toBeGreaterThan(0);
    expect(
      (
        await station.runtime.runPromise(
          station.repository.readSnapshot(sink.canvasName, sink.nodeId),
        )
      ).board.topics,
    ).toEqual([]);
    expect(
      (await station.runtime.runPromise(station.repository.pendingCommands))[0],
    ).toMatchObject({ resolution: { status: "applied" } });

    // Post round-trip: validateIncomingFact must short-circuit on Remote
    // (no local topic row) so disposition can apply — mailbox twin.
    const post = {
      postId: "fleet-post-1",
      topicId: topic.topicId,
      author: createdBy,
      parts: [{ kind: "text" as const, text: "hello from remote" }],
      position: 0,
      createdAt: observedAt,
    };
    const postCommand = await station.runtime.runPromise(
      station.repository.enqueueRemoteCommand({
        targetInstallationId: cc,
        sink,
        item: { kind: "post", itemId: post.postId, sink },
        action: {
          operation: "board.post.append",
          post,
          createdBy,
        },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const postAccepted = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [postCommand]),
    );
    expect(postAccepted.emitted.length).toBeGreaterThanOrEqual(2);
    const ccSnap = await commandCenter.runtime.runPromise(
      commandCenter.repository.readSnapshot(sink.canvasName, sink.nodeId),
    );
    const ccTopic = ccSnap.board.topics.find((t) => t.topicId === topic.topicId);
    expect(ccTopic?.postCount).toBe(1);
    expect(ccTopic?.posts?.some((p) => p.postId === post.postId)).toBe(true);

    const postReturned = await station.runtime.runPromise(
      accept(station.repository, cc, postAccepted.emitted),
    );
    expect(postReturned.accepted).toBeGreaterThan(0);
    expect(postReturned.rejected).toBe(0);
    expect(
      (await station.runtime.runPromise(station.repository.pendingCommands)).find(
        (c) => c.command.item.itemId === post.postId,
      ),
    ).toMatchObject({ resolution: { status: "applied" } });
    expect(
      await station.runtime.runPromise(
        station.state.read("test.board-remote-no-material", (reader) => ({
          topics: reader.get<{ readonly count: number }>(
            `
              SELECT count(*) AS count
              FROM work_board_topics
              WHERE canvas_name = ? AND node_id = ?
            `,
            [sink.canvasName, sink.nodeId],
          )!.count,
          posts: reader.get<{ readonly count: number }>(
            `
              SELECT count(*) AS count
              FROM work_board_posts
              WHERE canvas_name = ? AND node_id = ?
            `,
            [sink.canvasName, sink.nodeId],
          )!.count,
        })),
      ),
    ).toEqual({ topics: 0, posts: 0 });

    await commandCenter.runtime.dispose();
    await station.runtime.dispose();
  });
});
