import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { CanvasDoc, serializeCanvas } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  STATION_API_MAX_REPORT_BATCH_BYTES,
  STATION_API_PROTOCOL,
  StatusRequest,
  StatusResponse,
} from "../src/shared/station-api";
import {
  IntentFactBasis,
  WORK_PROTOCOL_MAX_RECORD_BYTES,
  WorkCommand,
  WorkFact,
  workRecordEncodedByteLength,
  type ActorRef,
  type WorkCommand as WorkCommandValue,
  type WorkFact as WorkFactValue,
} from "../src/shared/work-protocol";
import {
  makeStationWorkAdmission,
  mandatoryReportResponseReservationBytes,
  pageStationReport,
  selectStationReportRoutes,
  StationApiService,
  type StationApiPeerContext,
} from "../src/main/vellum/station/api";
import { ProjectedActorSeat } from "../src/main/vellum/station/actor-seat-compiler";
import { STATION_PORTFOLIO_PROTOCOL } from "../src/main/vellum/station/portfolio";
import { stationProjectionContentSha256 } from "../src/main/vellum/station/repository";
import { authorialMaterialForTest } from "./helpers/task-topology-authority";
import {
  admitEnrolledStationPeer,
  dispatchStationApiRequest,
  type RunStationApi,
  type StationTransportAdmission,
} from "../src/main/vellum/station/dispatcher";
import { mintStationPeerRoute } from "../src/main/vellum/station/peer-exchange";

const runEffect = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>);


const strictDecode = { onExcessProperty: "error" } as const;
const observedAt = "2026-07-27T18:00:00.000Z";
const contentSha256 = "a".repeat(64);

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const cc = installation("cc-station-api");
const remote = installation("remote-station-api");
const otherRemote = installation("other-remote-station-api");

const remoteActor: ActorRef = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(
    `seat_${"b".repeat(64)}`,
  ),
  canvasName: "factory",
  nodeId: "remote-actor",
};

const commandCenterActor: ActorRef = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(
    `seat_${"c".repeat(64)}`,
  ),
  canvasName: "factory",
  nodeId: "cc-actor",
};

const document = (connected: boolean) =>
  Schema.decodeUnknownSync(CanvasDoc, strictDecode)({
    nodes: [
      {
        id: remoteActor.nodeId,
        type: "text",
        x: 0,
        y: 0,
        width: 240,
        height: 100,
        text: "Remote actor",
        ether: {
          entity: { kind: "agent", name: "remote:builder" },
          host: "remote",
        },
      },
      {
        id: commandCenterActor.nodeId,
        type: "text",
        x: 0,
        y: 140,
        width: 240,
        height: 100,
        text: "Command Center actor",
        ether: {
          entity: { kind: "agent", name: "local:operator" },
          host: "local",
        },
      },
      {
        id: "cc-recipient",
        type: "text",
        x: 320,
        y: 140,
        width: 240,
        height: 100,
        text: "Command Center recipient",
        ether: {
          entity: { kind: "agent", name: "local:recipient" },
          host: "local",
        },
      },
      {
        id: "tasks",
        type: "text",
        x: 320,
        y: 0,
        width: 240,
        height: 100,
        text: "Tasks",
        ether: {
          entity: { kind: "task" },
          host: "local",
        },
      },
      {
        id: "other-remote-tasks",
        type: "text",
        x: 320,
        y: -140,
        width: 240,
        height: 100,
        text: "Other Remote tasks",
        ether: {
          entity: { kind: "task" },
          host: "other-remote",
        },
      },
      {
        id: "artifacts",
        type: "text",
        x: 600,
        y: 0,
        width: 240,
        height: 100,
        text: "Artifacts",
        ether: {
          entity: { kind: "artifacts" },
          host: "local",
        },
      },
      {
        id: "board",
        type: "text",
        x: 600,
        y: 140,
        width: 240,
        height: 100,
        text: "Board",
        ether: {
          entity: { kind: "board" },
          host: "local",
        },
      },
    ],
    edges: connected
      ? [
          {
            id: "actor-tasks",
            fromNode: remoteActor.nodeId,
            toNode: "tasks",
            ether: { verb: "contributes" },
          },
          {
            id: "actor-mailbox",
            fromNode: remoteActor.nodeId,
            toNode: "cc-recipient",
            ether: { verb: "messages" },
          },
          {
            id: "actor-artifacts",
            fromNode: remoteActor.nodeId,
            toNode: "artifacts",
            ether: { verb: "publishes" },
          },
          {
            id: "actor-board",
            fromNode: remoteActor.nodeId,
            toNode: "board",
            ether: { verb: "participates" },
          },
          {
            id: "cc-actor-tasks",
            fromNode: commandCenterActor.nodeId,
            toNode: "tasks",
            ether: { verb: "contributes" },
          },
        ]
      : [],
  });

const projectedRemoteActor = Schema.decodeUnknownSync(
  ProjectedActorSeat,
  strictDecode,
)({
  seatId: remoteActor.seatId,
  authorityInstallationId: remote,
  hostId: "remote",
  bindingId: "remote-builder",
  agentKey: "remote:builder",
  harness: "codex",
  primaryRef: {
    canvasName: remoteActor.canvasName,
    nodeId: remoteActor.nodeId,
  },
  refs: [
    {
      canvasName: remoteActor.canvasName,
      nodeId: remoteActor.nodeId,
    },
  ],
});

const projectedCommandCenterActor = Schema.decodeUnknownSync(
  ProjectedActorSeat,
  strictDecode,
)({
  seatId: commandCenterActor.seatId,
  authorityInstallationId: cc,
  hostId: "local",
  bindingId: "cc-operator",
  agentKey: "local:operator",
  harness: "codex",
  primaryRef: {
    canvasName: commandCenterActor.canvasName,
    nodeId: commandCenterActor.nodeId,
  },
  refs: [
    {
      canvasName: commandCenterActor.canvasName,
      nodeId: commandCenterActor.nodeId,
    },
  ],
});

type AdmissionTopology = Parameters<typeof makeStationWorkAdmission>[0];

const topology = (
  localRole: "command-center" | "remote",
  connected = true,
): AdmissionTopology => {
  const doc = document(connected);
  const actorSeats = [projectedRemoteActor, projectedCommandCenterActor];
  if (localRole === "command-center") {
    const authority = authorialMaterialForTest({
      generation: "1",
      documents: new Map([
        ["factory", { document: doc, rawBody: serializeCanvas(doc) }],
      ]),
    });
    return {
      localInstallationId: cc,
      peerInstallationId: remote,
      localRole,
      localHostId: "local",
      intentBasis: Schema.decodeUnknownSync(IntentFactBasis, strictDecode)({
        kind: "authorial-intent",
        generation: authority.generation,
        contentSha256: authority.intentSha256,
      }),
      taskTopologyMaterial: { kind: "authorial-current", authority },
      documents: authority.documents,
      actorSeats,
      installationByHostId: new Map([
        ["local", cc],
        ["remote", remote],
        ["other-remote", otherRemote],
      ]),
    };
  }
  const rawBody = JSON.stringify({
    protocol: STATION_PORTFOLIO_PROTOCOL,
    documents: [{ name: "factory", body: serializeCanvas(doc) }],
    actorSeats,
  });
  const contentSha256 = stationProjectionContentSha256(rawBody);
  return {
    localInstallationId: remote,
    peerInstallationId: cc,
    localRole,
    localHostId: "remote",
    intentBasis: Schema.decodeUnknownSync(IntentFactBasis, strictDecode)({
      kind: "projected-intent",
      generation: "1",
      contentSha256,
    }),
    taskTopologyMaterial: {
      kind: "projected-current",
      rawBody,
      generation: "1",
      contentSha256,
    },
    documents: new Map([["factory", doc]]),
    actorSeats,
    installationByHostId: new Map([
      ["local", cc],
      ["remote", remote],
      ["other-remote", otherRemote],
    ]),
  };
};

const message = {
  messageId: "message-1",
  role: "agent" as const,
  parts: [{ kind: "text" as const, text: "hello from the Remote" }],
  contextId: "factory",
};

const messageCommand = (
  sentBy: ActorRef = remoteActor,
): WorkCommandValue =>
  Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    protocol: "vellum/work/v2",
    id: {
      route: { eventHome: remote, entityHome: cc },
      seq: "1",
    },
    recordType: "command",
    item: {
      kind: "message",
      itemId: message.messageId,
      sink: { canvasName: "factory", nodeId: "cc-recipient" },
    },
    operation: "message.append",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "message.append",
      message,
      sentBy,
      destination: { kind: "mailbox" },
    },
  });

const messageFact = (): WorkFactValue =>
  Schema.decodeUnknownSync(WorkFact, strictDecode)({
    protocol: "vellum/work/v2",
    id: {
      route: { eventHome: cc, entityHome: cc },
      seq: "1",
    },
    recordType: "fact",
    basis: {
      kind: "command",
      command: messageCommand().id,
      commandSha256: messageCommand().contentSha256,
    },
    item: {
      kind: "message",
      itemId: message.messageId,
      sink: { canvasName: "factory", nodeId: "cc-recipient" },
    },
    operation: "message.append",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "message.append",
      message,
      sentBy: remoteActor,
      destination: { kind: "mailbox" },
    },
  });

const threadMessage = {
  ...message,
  messageId: "task-note-1",
  taskId: "task-1",
};

const threadCommand = (): WorkCommandValue =>
  Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    protocol: "vellum/work/v2",
    id: {
      route: { eventHome: cc, entityHome: remote },
      seq: "1",
    },
    recordType: "command",
    item: {
      kind: "message",
      itemId: threadMessage.messageId,
      sink: { canvasName: "factory", nodeId: "tasks" },
    },
    operation: "message.append",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "message.append",
      message: threadMessage,
      sentBy: commandCenterActor,
      destination: { kind: "task", itemId: "task-1" },
    },
  });

const remoteThreadCommand = (): WorkCommandValue =>
  Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    ...threadCommand(),
    id: {
      route: { eventHome: remote, entityHome: cc },
      seq: "2",
    },
    body: {
      ...threadCommand().body,
      sentBy: remoteActor,
    },
  });

const threadFact = (): WorkFactValue =>
  Schema.decodeUnknownSync(WorkFact, strictDecode)({
    protocol: "vellum/work/v2",
    id: {
      route: { eventHome: remote, entityHome: remote },
      seq: "1",
    },
    recordType: "fact",
    basis: {
      kind: "projected-intent",
      generation: "1",
      contentSha256,
    },
    item: {
      kind: "message",
      itemId: threadMessage.messageId,
      sink: { canvasName: "factory", nodeId: "tasks" },
    },
    operation: "message.append",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "message.append",
      message: threadMessage,
      sentBy: remoteActor,
      destination: { kind: "task", itemId: "task-1" },
    },
  });

const artifactFact = (
  taskNodeId = "tasks",
): WorkFactValue =>
  Schema.decodeUnknownSync(WorkFact, strictDecode)({
    protocol: "vellum/work/v2",
    id: {
      route: { eventHome: remote, entityHome: remote },
      seq: "2",
    },
    recordType: "fact",
    basis: {
      kind: "projected-intent",
      generation: "1",
      contentSha256,
    },
    item: {
      kind: "artifact",
      itemId: "artifact-1",
      sink: { canvasName: "factory", nodeId: "artifacts" },
    },
    operation: "artifact.publish",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "artifact.publish",
      artifact: {
        artifactId: "artifact-1",
        parts: [{ kind: "text", text: "proof" }],
        task: {
          kind: "task",
          itemId: "task-1",
          sink: { canvasName: "factory", nodeId: taskNodeId },
        },
      },
      publishedBy: remoteActor,
    },
  });

const taskDescribeCommand = (
  sender: InstallationIdValue,
  target: InstallationIdValue,
): WorkCommandValue =>
  Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    protocol: "vellum/work/v2",
    id: {
      route: { eventHome: sender, entityHome: target },
      seq: "1",
    },
    recordType: "command",
    item: {
      kind: "task",
      itemId: "task-1",
      sink: { canvasName: "factory", nodeId: "tasks" },
    },
    operation: "task.describe",
    contentSha256,
    originAt: observedAt,
    predecessor: {
      route: { eventHome: target, entityHome: target },
      seq: "1",
    },
    body: {
      operation: "task.describe",
      taskId: "task-1",
      message: {
        messageId: "description-1",
        role: "user",
        parts: [{ kind: "text", text: "changed by the operator" }],
      },
    },
  });

const agentTaskCreateCommand = (
  raisedBy: ActorRef | null = remoteActor,
  sinkNodeId = "tasks",
): WorkCommandValue =>
  Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    protocol: "vellum/work/v2",
    id: {
      route: { eventHome: remote, entityHome: cc },
      seq: "3",
    },
    recordType: "command",
    item: {
      kind: "task",
      itemId: "agent-task-1",
      sink: { canvasName: "factory", nodeId: sinkNodeId },
    },
    operation: "task.create",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "task.create",
      task: {
        id: "agent-task-1",
        state: "submitted",
        history: [],
        ...(raisedBy === null ? {} : { raisedBy }),
      },
    },
  });

const localTaskFact = (seq: number): WorkFactValue => {
  const taskId = `local-task-${seq}`;
  return Schema.decodeUnknownSync(WorkFact, strictDecode)({
    protocol: "vellum/work/v2",
    id: {
      route: { eventHome: remote, entityHome: remote },
      seq: String(seq),
    },
    recordType: "fact",
    basis: {
      kind: "projected-intent",
      generation: "1",
      contentSha256,
    },
    item: {
      kind: "task",
      itemId: taskId,
      sink: { canvasName: "factory", nodeId: "tasks" },
    },
    operation: "task.create",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "task.create",
      task: {
        id: taskId,
        state: "submitted",
        history: [],
      },
    },
  });
};

const largeTaskCreateCommand = (
  seq: number,
): WorkCommandValue => {
  const itemId = `large-task-${seq}`;
  return Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    protocol: "vellum/work/v2",
    id: {
      route: { eventHome: cc, entityHome: remote },
      seq: String(seq),
    },
    recordType: "command",
    item: {
      kind: "task",
      itemId,
      sink: { canvasName: "factory", nodeId: "tasks" },
    },
    operation: "task.create",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "task.create",
      task: {
        id: itemId,
        state: "submitted",
        history: [
          {
            messageId: `brief-${seq}`,
            role: "user",
            parts: [
              {
                kind: "text",
                text: "x".repeat(220 * 1024),
              },
            ],
          },
        ],
      },
    },
  });
};

describe("Station API v1 work routing", () => {
  it("pages large commands only while their mandatory responses fit", async () => {
    const commands = Array.from(
      { length: 16 },
      (_, index) => largeTaskCreateCommand(index + 1),
    );
    const work = {
      recordsAfter: () => Effect.succeed(commands),
    } as unknown as Parameters<typeof pageStationReport>[0];
    const facts = {
      installationId: cc,
      receivedThrough: [],
      peerAcknowledgedThrough: [],
    } as Parameters<typeof pageStationReport>[1];

    expect(
      commands.every((command) => {
        const bytes = workRecordEncodedByteLength(command);
        return (
          bytes !== undefined &&
          bytes > 200 * 1024 &&
          bytes <= WORK_PROTOCOL_MAX_RECORD_BYTES
        );
      }),
    ).toBe(true);

    const batch = await runEffect(
      pageStationReport(
        work,
        facts,
        cc,
        remote,
        [],
        [],
        "command-center",
        true,
      ),
    );

    expect(batch.records).toHaveLength(15);
    expect(batch.hasMore).toBe(true);
    expect(
      mandatoryReportResponseReservationBytes(batch.records),
    ).toBeLessThanOrEqual(STATION_API_MAX_REPORT_BATCH_BYTES);
    expect(
      mandatoryReportResponseReservationBytes([
        ...batch.records,
        commands[15]!,
      ]),
    ).toBeGreaterThan(STATION_API_MAX_REPORT_BATCH_BYTES);
  });

  it("pages the unacknowledged route prefix before mandatory outcomes", async () => {
    const routeRecords = Array.from(
      { length: 259 },
      (_, index) => localTaskFact(index + 1),
    );
    const work = {
      recordsAfter: (input: { readonly after?: string; readonly limit: number }) => {
        const after = input.after === undefined ? 0n : BigInt(input.after);
        return Effect.succeed(
          routeRecords
            .filter((record) => BigInt(record.id.seq) > after)
            .slice(0, input.limit),
        );
      },
    } as unknown as Parameters<typeof pageStationReport>[0];
    const initialFacts = {
      installationId: remote,
      receivedThrough: [],
      peerAcknowledgedThrough: [],
    } as Parameters<typeof pageStationReport>[1];
    const mandatory = routeRecords.slice(257);

    const first = await runEffect(
      pageStationReport(
        work,
        initialFacts,
        remote,
        cc,
        [],
        mandatory,
        "remote",
        false,
      ),
    );
    expect(first.records.map((record) => record.id.seq)).toEqual(
      Array.from({ length: 256 }, (_, index) => String(index + 1)),
    );
    expect(first.records.some((record) => record.id.seq === "258")).toBe(false);
    expect(first.records.some((record) => record.id.seq === "259")).toBe(false);
    expect(first.hasMore).toBe(true);

    const nextFacts = {
      ...initialFacts,
      peerAcknowledgedThrough: [
        {
          peerInstallationId: cc,
          acknowledgement: {
            eventHome: remote,
            entityHome: remote,
            through: routeRecords[255]!.id.seq,
          },
        },
      ],
    } as Parameters<typeof pageStationReport>[1];
    const second = await runEffect(
      pageStationReport(
        work,
        nextFacts,
        remote,
        cc,
        [],
        mandatory,
        "remote",
        false,
      ),
    );
    expect(second.records.map((record) => record.id.seq)).toEqual([
      "257",
      "258",
      "259",
    ]);
    expect(second.hasMore).toBe(false);
  });

  it("admits only exact Remote actor Task creates at a Command Center queue", () => {
    const admission = makeStationWorkAdmission(topology("command-center"));
    const accepted = admission.authorizeCommand(agentTaskCreateCommand());
    expect(accepted).toMatchObject({ _tag: "admitted" });
    if (
      accepted._tag !== "admitted" ||
      accepted.taskDependencyScope === undefined
    ) throw new Error("expected topology-authorized admission");
    expect(Object.isFrozen(accepted.taskDependencyScope)).toBe(true);
    expect(Reflect.ownKeys(accepted.taskDependencyScope)).toEqual([]);
    expect(
      admission.authorizeCommand(agentTaskCreateCommand(null)),
    ).toMatchObject({
      _tag: "rejected",
      reason: "authority-mismatch",
    });
    expect(
      admission.authorizeCommand(
        agentTaskCreateCommand({
          ...remoteActor,
          nodeId: "forged-remote-actor",
        }),
      ),
    ).toMatchObject({
      _tag: "rejected",
      reason: "locality-mismatch",
    });
    expect(
      admission.authorizeCommand(
        agentTaskCreateCommand(remoteActor, "other-remote-tasks"),
      ),
    ).toMatchObject({
      _tag: "rejected",
      reason: "locality-mismatch",
    });
    const stableIdentityMismatch = agentTaskCreateCommand();
    expect(
      admission.authorizeCommand({
        ...stableIdentityMismatch,
        item: {
          ...stableIdentityMismatch.item,
          itemId: "different-item",
        },
      }),
    ).toMatchObject({
      _tag: "rejected",
      reason: "identity-conflict",
    });
    expect(
      makeStationWorkAdmission(
        topology("command-center", false),
      ).authorizeCommand(agentTaskCreateCommand()),
    ).toMatchObject({
      _tag: "rejected",
      reason: "capability-denied",
    });
    const wrongEntityHome = agentTaskCreateCommand();
    expect(
      admission.authorizeCommand({
        ...wrongEntityHome,
        id: {
          ...wrongEntityHome.id,
          route: {
            ...wrongEntityHome.id.route,
            entityHome: otherRemote,
          },
        },
      }),
    ).toMatchObject({
      _tag: "rejected",
      reason: "authority-mismatch",
    });
  });

  it("never broadcasts Command Center local facts to Remote peers", () => {
    const first = selectStationReportRoutes(
      "command-center",
      cc,
      remote,
    );
    const second = selectStationReportRoutes(
      "command-center",
      cc,
      otherRemote,
    );

    expect(first).toEqual({
      facts: undefined,
      commands: { eventHome: cc, entityHome: remote },
    });
    expect(second).toEqual({
      facts: undefined,
      commands: { eventHome: cc, entityHome: otherRemote },
    });
    expect(
      selectStationReportRoutes("remote", remote, cc),
    ).toEqual({
      facts: { eventHome: remote, entityHome: remote },
      commands: { eventHome: remote, entityHome: cc },
    });
  });

  it("rejects Remote attempts to forge Command Center operator commands", () => {
    const admission = makeStationWorkAdmission(
      topology("command-center"),
    );

    expect(
      admission.authorizeCommand(taskDescribeCommand(remote, cc)),
    ).toMatchObject({
      _tag: "rejected",
      reason: "authority-mismatch",
    });
  });

  it("admits only provenance-bound, edge-authorized Remote mailbox commands", () => {
    const admitted = makeStationWorkAdmission(
      topology("command-center"),
    );
    expect(admitted.authorizeCommand(messageCommand())).toEqual({
      _tag: "admitted",
    });

    const wrongActor = {
      ...remoteActor,
      nodeId: "forged-actor",
    };
    expect(
      admitted.authorizeCommand(messageCommand(wrongActor)),
    ).toMatchObject({
      _tag: "rejected",
      reason: "locality-mismatch",
    });

    const disconnected = makeStationWorkAdmission(
      topology("command-center", false),
    );
    expect(
      disconnected.authorizeCommand(messageCommand()),
    ).toMatchObject({
      _tag: "rejected",
      reason: "capability-denied",
    });
  });

  const boardAuthor = {
    kind: "actor" as const,
    seatId: remoteActor.seatId,
    nodeId: remoteActor.nodeId,
    label: remoteActor.nodeId,
  };

  const boardTopicCommand = (): WorkCommandValue =>
    Schema.decodeUnknownSync(WorkCommand, strictDecode)({
      protocol: "vellum/work/v2",
      id: {
        route: { eventHome: remote, entityHome: cc },
        seq: "11",
      },
      recordType: "command",
      item: {
        kind: "topic",
        itemId: "topic-1",
        sink: { canvasName: "factory", nodeId: "board" },
      },
      operation: "board.topic.create",
      contentSha256,
      originAt: observedAt,
      predecessor: null,
      body: {
        operation: "board.topic.create",
        createdBy: boardAuthor,
        topic: {
          topicId: "topic-1",
          title: "fleet note",
          state: "open",
          openedBy: boardAuthor,
          openedAt: observedAt,
          postCount: 0,
          lastActivityAt: observedAt,
        },
      },
    });

  const boardPostCommand = (): WorkCommandValue =>
    Schema.decodeUnknownSync(WorkCommand, strictDecode)({
      protocol: "vellum/work/v2",
      id: {
        route: { eventHome: remote, entityHome: cc },
        seq: "12",
      },
      recordType: "command",
      item: {
        kind: "post",
        itemId: "post-1",
        sink: { canvasName: "factory", nodeId: "board" },
      },
      operation: "board.post.append",
      contentSha256,
      originAt: observedAt,
      predecessor: null,
      body: {
        operation: "board.post.append",
        createdBy: boardAuthor,
        post: {
          postId: "post-1",
          topicId: "topic-1",
          author: boardAuthor,
          parts: [{ kind: "text", text: "hello board" }],
          position: 0,
          createdAt: observedAt,
        },
      },
    });

  it("admits Remote board create/post only with the matching board port", () => {
    const full = makeStationWorkAdmission(topology("command-center"));
    expect(full.authorizeCommand(boardTopicCommand())).toEqual({
      _tag: "admitted",
    });
    expect(full.authorizeCommand(boardPostCommand())).toEqual({
      _tag: "admitted",
    });

    const actorTopicCommand = boardTopicCommand();
    if (actorTopicCommand.body.operation !== "board.topic.create") {
      throw new Error("boardTopicCommand must build board.topic.create");
    }
    const operatorAuthored = Schema.decodeUnknownSync(
      WorkCommand,
      strictDecode,
    )({
      ...actorTopicCommand,
      body: {
        ...actorTopicCommand.body,
        createdBy: { kind: "operator", label: "operator" },
        topic: {
          ...actorTopicCommand.body.topic,
          openedBy: { kind: "operator", label: "operator" },
        },
      },
    });
    expect(full.authorizeCommand(operatorAuthored)).toMatchObject({
      _tag: "rejected",
      reason: "authority-mismatch",
    });

    // The narrow board verb: post and read, never open a topic.
    const postOnlyDoc = Schema.decodeUnknownSync(CanvasDoc, strictDecode)({
      ...document(true),
      edges: document(true).edges.map((edge) =>
        edge.id === "actor-board"
          ? { ...edge, ether: { verb: "messages" } }
          : edge
      ),
    });
    const postOnly = makeStationWorkAdmission({
      ...topology("command-center"),
      documents: new Map([["factory", postOnlyDoc]]),
    });
    expect(postOnly.authorizeCommand(boardTopicCommand())).toMatchObject({
      _tag: "rejected",
      reason: "capability-denied",
    });
    expect(postOnly.authorizeCommand(boardPostCommand())).toEqual({
      _tag: "admitted",
    });

    const disconnected = makeStationWorkAdmission(
      topology("command-center", false),
    );
    expect(disconnected.authorizeCommand(boardPostCommand())).toMatchObject({
      _tag: "rejected",
      reason: "capability-denied",
    });

    // Remote cannot apply board commands: route is Remote→CC (not peer→local).
    const remoteHome = makeStationWorkAdmission(topology("remote"));
    expect(remoteHome.authorizeCommand(boardTopicCommand())).toMatchObject({
      _tag: "rejected",
      reason: "authority-mismatch",
    });
  });

  it("keeps an exact correlated CC mailbox fact admitted after edge removal", () => {
    const admitted = makeStationWorkAdmission(topology("remote"));
    expect(admitted.authorizeFact(messageFact())).toEqual({
      _tag: "admitted",
    });

    // The unresolved durable command is the prior authorization. Mutable
    // topology cannot strand its byte-exact response; repository correlation
    // rejects a forged command id, hash, route, operation, or result.
    const disconnected = makeStationWorkAdmission(
      topology("remote", false),
    );
    expect(disconnected.authorizeFact(messageFact())).toEqual({
      _tag: "admitted",
    });
  });

  it("still admits Command Center operator mutations onto Remote-owned rows", () => {
    const admission = makeStationWorkAdmission(topology("remote"));

    expect(
      admission.authorizeCommand(taskDescribeCommand(cc, remote)),
    ).toEqual({ _tag: "admitted" });
  });

  it("admits Command Center thread commands onto Remote-owned rows", () => {
    const admission = makeStationWorkAdmission(topology("remote"));

    expect(admission.authorizeCommand(threadCommand())).toEqual({
      _tag: "admitted",
    });
  });

  it("admits Remote thread commands onto Command Center-owned rows", () => {
    const admission = makeStationWorkAdmission(
      topology("command-center"),
    );

    expect(admission.authorizeCommand(remoteThreadCommand())).toEqual({
      _tag: "admitted",
    });
  });

  it("admits Remote thread facts into the Command Center replica", () => {
    const admission = makeStationWorkAdmission(
      topology("command-center"),
    );

    expect(admission.authorizeFact(threadFact())).toEqual({
      _tag: "admitted",
    });
  });

  it("requires every linked artifact task sink in the installed projection", () => {
    const admission = makeStationWorkAdmission(
      topology("command-center"),
    );
    expect(admission.authorizeFact(artifactFact())).toEqual({
      _tag: "admitted",
    });
    expect(
      admission.authorizeFact(artifactFact("missing-tasks")),
    ).toMatchObject({
      _tag: "rejected",
      reason: "missing-entity",
    });
    expect(
      admission.authorizeFact(artifactFact("cc-recipient")),
    ).toMatchObject({
      _tag: "rejected",
      reason: "capability-denied",
    });

    const absentCanvas = makeStationWorkAdmission({
      ...topology("command-center"),
      documents: new Map(),
    });
    expect(absentCanvas.authorizeFact(artifactFact())).toMatchObject({
      _tag: "rejected",
      reason: "projection-conflict",
    });
  });

  it("rejects a message destination that does not match the projected sink kind", () => {
    const mismatched = Schema.decodeUnknownSync(
      WorkCommand,
      strictDecode,
    )({
      ...threadCommand(),
      item: {
        kind: "message",
        itemId: threadMessage.messageId,
        sink: { canvasName: "factory", nodeId: "cc-recipient" },
      },
    });
    const admission = makeStationWorkAdmission(topology("remote"));

    expect(admission.authorizeCommand(mismatched)).toMatchObject({
      _tag: "rejected",
      reason: "capability-denied",
    });
  });

  it("binds the exact enrolled Remote identity into an opaque dispatcher admission", async () => {
    const readiness = {
      database: true,
      workControl: true,
      simulation: true,
      session: true,
    } as const;
    const request = StatusRequest.make({
      protocol: STATION_API_PROTOCOL,
      op: "status",
    });
    let observedPeer: StationApiPeerContext | undefined;
    const service = StationApiService.of({
      handle: (_request, _readiness, peer) =>
        Effect.sync(() => {
          observedPeer = peer;
          return StatusResponse.make({
            protocol: STATION_API_PROTOCOL,
            op: "status",
            installationId: cc,
            state: "ready",
            receivedThrough: [],
            peerAcknowledgedThrough: [],
            readiness,
            observedAt,
          });
        }),
      prepareReport: () => Effect.die("not used"),
      acceptReportResponse: () => Effect.die("not used"),
    });
    const run: RunStationApi = (effect) =>
      Effect.runPromise(
        Effect.provideService(effect, StationApiService, service),
      );

    const admission = admitEnrolledStationPeer(
      mintStationPeerRoute(remote),
    );
    const accepted = await dispatchStationApiRequest(
      admission,
      request,
      readiness,
      run,
    );
    expect(accepted.ok).toBe(true);
    expect(observedPeer).toEqual({
      _tag: "enrolled-remote",
      installationId: remote,
    });

    observedPeer = undefined;
    const forged = Object.freeze({
      _tag: "StationTransportAdmission" as const,
    }) as StationTransportAdmission;
    const denied = await dispatchStationApiRequest(
      forged,
      request,
      readiness,
      run,
    );
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "authorization_denied" },
    });
    expect(observedPeer).toBeUndefined();
  });
});
