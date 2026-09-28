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
  type WorkCommand as WorkCommandValue,
  type WorkRecord as WorkRecordValue,
} from "../src/shared/work-protocol";
import {
  workRecordContentSha256,
  WorkReplicationError,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import { stationProjectionContentSha256 } from "../src/main/junto/station/repository";
import { compileStationPortfolioBody } from "../src/main/junto/station/portfolio";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import { authorialMaterialForTest } from "./helpers/task-topology-authority";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";

const observedAt = "2026-07-27T18:00:00.000Z";
// Mailboxes need no authored sink: the topology is empty and every inbox
// below is addressed by node id alone.
const fixtureTopology: CanvasDoc = { nodes: [], edges: [] };
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
) => ({
  messageId,
  role,
  parts: [{ kind: "text" as const, text }],
  contextId: "factory",
});

const openInstallation = async (
  local: InstallationIdValue,
  peers: ReadonlyArray<InstallationIdValue>,
  role: "command-center" | "remote",
) => {
  const root = join(
    tmpdir(),
    `junto-work-replication-v2-${local}-${randomUUID()}`,
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "junto.db")),
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

/** A Remote seat's mail, enqueued as a command for the Command Center. */
const enqueueMail = (
  station: Awaited<ReturnType<typeof openInstallation>>,
  target: InstallationIdValue,
  sink: { readonly canvasName: string; readonly nodeId: string },
  mail: ReturnType<typeof message>,
  sentBy: ReturnType<typeof actor>,
) =>
  station.runtime.runPromise(
    station.repository.enqueueRemoteCommand({
      targetInstallationId: target,
      sink,
      item: { kind: "message", itemId: mail.messageId, sink },
      action: {
        operation: "message.append",
        message: mail,
        sentBy,
        destination: { kind: "mailbox" },
      },
      originAt: observedAt,
      receivedAt: observedAt,
    }),
  );

const mailCount = (
  installation: Awaited<ReturnType<typeof openInstallation>>,
) =>
  installation.runtime.runPromise(
    installation.state.read(
      "test.read-mail-count",
      (reader) =>
        reader.get<{ readonly count: number }>(
          "SELECT count(*) AS count FROM work_messages",
        )!.count,
    ),
  );

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
    const sink = { canvasName: "factory", nodeId: "inbox" };
    const localFact = await commandCenter.runtime.runPromise(
      commandCenter.repository.appendMessage({
        sink,
        basis: commandCenter.basis,
        message: message("local-outbound", "agent", "from the Command Center"),
        sentBy: actor("1", "cc-sender"),
        destination: { kind: "mailbox" },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const acknowledgement = RouteCursor.make({
      eventHome: cc,
      entityHome: cc,
      through: localFact.record.id.seq,
    });
    const remoteCommand = await enqueueMail(
      station,
      cc,
      sink,
      message("remote-created", "agent", "from the Remote"),
      actor("2", "remote-sender"),
    );
    const rejected = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [remoteCommand], {
        peerAcknowledgements: [acknowledgement],
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
    const inboxIds = async () =>
      (
        await commandCenter.runtime.runPromise(
          commandCenter.repository.readSnapshot(
            sink.canvasName,
            sink.nodeId,
          ),
        )
      ).messages.items.map((item) => item.messageId);
    expect(await inboxIds()).toEqual(["local-outbound"]);

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
    expect(await inboxIds()).toEqual(
      expect.arrayContaining(["local-outbound", "remote-created"]),
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

  it("replays the exact durable disposition and commits rejections as outcomes", async () => {
    const cc = installation("cc-replay");
    const remote = installation("remote-replay");
    const commandCenter = await openInstallation(
      cc,
      [remote],
      "command-center",
    );
    const station = await openInstallation(remote, [cc], "remote");
    const sink = { canvasName: "factory", nodeId: "replay-inbox" };

    const command = await enqueueMail(
      station,
      cc,
      sink,
      message("mail-replay", "agent", "retry me"),
      actor("b"),
    );
    const first = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [command], {
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

    const replay = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [command]),
    );
    expect(replay).toMatchObject({
      accepted: 0,
      rejected: 0,
      idempotent: 1,
      acknowledge: [
        { eventHome: remote, entityHome: cc, through: "1" },
      ],
    });
    expect(replay.emitted).toEqual(first.emitted);
    expect(await mailCount(commandCenter)).toBe(0);

    await station.runtime.runPromise(
      accept(station.repository, cc, first.emitted),
    );
    expect(
      (await station.runtime.runPromise(
        station.repository.pendingCommands,
      ))[0],
    ).toMatchObject({ resolution: { status: "rejected" } });
  });

  it("rolls back gaps, hash conflicts, false local authority, and identity conflicts without advancing a cursor", async () => {
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
    const sink = { canvasName: "factory", nodeId: "integrity-inbox" };
    const command = await enqueueMail(
      station,
      cc,
      sink,
      message("mail-integrity", "agent", "protect me"),
      actor("c"),
    );

    const gap = reseal({
      ...command,
      id: { ...command.id, seq: "2" as typeof command.id.seq },
    });
    const gapResult = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [gap]).pipe(Effect.result),
    );
    expect(Result.isFailure(gapResult)).toBe(true);
    if (Result.isFailure(gapResult)) {
      expect(gapResult.failure).toMatchObject({ reason: "sequence-gap" });
    }

    const falseAuthority = await other.runtime.runPromise(
      accept(other.repository, remote, [command]).pipe(Effect.result),
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
    const hashResult = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [badHash]).pipe(Effect.result),
    );
    expect(Result.isFailure(hashResult)).toBe(true);
    if (Result.isFailure(hashResult)) {
      expect(hashResult.failure).toMatchObject({ reason: "integrity" });
    }
    expect(await mailCount(commandCenter)).toBe(0);

    const admittedResult = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [command]),
    );
    expect(admittedResult.acknowledge).toEqual([
      { eventHome: remote, entityHome: cc, through: "1" },
    ]);
    expect(await mailCount(commandCenter)).toBe(1);

    if (command.body.operation !== "message.append") {
      throw new Error("test mail command narrowed incorrectly");
    }
    const conflicting = reseal({
      ...command,
      body: {
        ...command.body,
        message: message("mail-integrity", "agent", "a different body"),
      },
    });
    const conflict = await commandCenter.runtime.runPromise(
      accept(commandCenter.repository, remote, [conflicting]).pipe(
        Effect.result,
      ),
    );
    expect(Result.isFailure(conflict)).toBe(true);
    if (Result.isFailure(conflict)) {
      expect(conflict.failure).toBeInstanceOf(WorkReplicationError);
      expect(conflict.failure).toMatchObject({
        reason: "identity-conflict",
      });
    }
  });
});
