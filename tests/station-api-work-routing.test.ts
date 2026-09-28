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
} from "../src/main/junto/station/api";
import { ProjectedActorSeat } from "../src/main/junto/station/actor-seat-compiler";
import { STATION_PORTFOLIO_PROTOCOL } from "../src/main/junto/station/portfolio";
import { stationProjectionContentSha256 } from "../src/main/junto/station/repository";
import { authorialMaterialForTest } from "./helpers/task-topology-authority";
import {
  admitEnrolledStationPeer,
  dispatchStationApiRequest,
  type RunStationApi,
  type StationTransportAdmission,
} from "../src/main/junto/station/dispatcher";
import { mintStationPeerRoute } from "../src/main/junto/station/peer-exchange";

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

const remoteOverseer: ActorRef = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(
    `seat_${"d".repeat(64)}`,
  ),
  canvasName: "publisher-home",
  nodeId: "remote-overseer",
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
    ],
    edges: connected
      ? [
          {
            id: "actor-mailbox",
            fromNode: remoteActor.nodeId,
            toNode: "cc-recipient",
            ether: { verb: "messages" },
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

const projectedRemoteOverseer = Schema.decodeUnknownSync(
  ProjectedActorSeat,
  strictDecode,
)({
  seatId: remoteOverseer.seatId,
  authorityInstallationId: remote,
  hostId: "remote",
  overseer: true,
  bindingId: "remote-overseer",
  agentKey: "remote:overseer",
  harness: "codex",
  primaryRef: {
    canvasName: remoteOverseer.canvasName,
    nodeId: remoteOverseer.nodeId,
  },
  refs: [
    {
      canvasName: remoteOverseer.canvasName,
      nodeId: remoteOverseer.nodeId,
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

const remoteOverseerTopology = (
  seat: ProjectedActorSeat = projectedRemoteOverseer,
): AdmissionTopology => {
  const base = topology("remote");
  const publisherHome = Schema.decodeUnknownSync(CanvasDoc, strictDecode)({
    nodes: [
      {
        id: remoteOverseer.nodeId,
        type: "text",
        x: 0,
        y: 0,
        width: 240,
        height: 100,
        text: "Remote overseer",
        ether: {
          entity: { kind: "agent", name: "remote:overseer" },
          host: "remote",
          overseer: seat.overseer === true,
        },
      },
    ],
    edges: [],
  });
  return {
    ...base,
    documents: new Map([
      ...base.documents,
      [remoteOverseer.canvasName, publisherHome] as const,
    ]),
    actorSeats: [...base.actorSeats, seat],
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
    protocol: "junto/work/v1",
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
    protocol: "junto/work/v1",
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

const remoteOverseerMailboxCommand = (): WorkCommandValue =>
  Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    protocol: "junto/work/v1",
    id: {
      route: { eventHome: remote, entityHome: cc },
      seq: "14",
    },
    recordType: "command",
    item: {
      kind: "message",
      itemId: "overseer-mail-1",
      sink: { canvasName: "factory", nodeId: "cc-recipient" },
    },
    operation: "message.append",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "message.append",
      message: {
        messageId: "overseer-mail-1",
        role: "agent",
        parts: [{ kind: "text", text: "overseer mail" }],
        contextId: "factory",
      },
      sentBy: remoteOverseer,
      destination: { kind: "mailbox" },
    },
  });

const largeMailCommand = (seq: number): WorkCommandValue => {
  const messageId = `large-mail-${seq}`;
  return Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    protocol: "junto/work/v1",
    id: {
      route: { eventHome: remote, entityHome: cc },
      seq: String(seq),
    },
    recordType: "command",
    item: {
      kind: "message",
      itemId: messageId,
      sink: { canvasName: "factory", nodeId: "cc-recipient" },
    },
    operation: "message.append",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "message.append",
      message: {
        messageId,
        role: "agent",
        parts: [{ kind: "text", text: "x".repeat(220 * 1024) }],
        contextId: "factory",
      },
      sentBy: remoteActor,
      destination: { kind: "mailbox" },
    },
  });
};

/** The Command Center's fact answering a Remote seat's mail command. */
const commandCenterMailFact = (seq: number): WorkFactValue => {
  const messageId = `answered-mail-${seq}`;
  return Schema.decodeUnknownSync(WorkFact, strictDecode)({
    protocol: "junto/work/v1",
    id: {
      route: { eventHome: cc, entityHome: cc },
      seq: String(seq),
    },
    recordType: "fact",
    basis: {
      kind: "authorial-intent",
      generation: "1",
      contentSha256,
    },
    item: {
      kind: "message",
      itemId: messageId,
      sink: { canvasName: "factory", nodeId: "cc-recipient" },
    },
    operation: "message.append",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "message.append",
      message: {
        messageId,
        role: "agent",
        parts: [{ kind: "text", text: "delivered" }],
        contextId: "factory",
      },
      sentBy: remoteActor,
      destination: { kind: "mailbox" },
    },
  });
};

describe("Station API v1 work routing", () => {
  it("pages large commands only while their mandatory responses fit", async () => {
    const commands = Array.from(
      { length: 16 },
      (_, index) => largeMailCommand(index + 1),
    );
    const work = {
      recordsAfter: (input: { readonly route: { readonly eventHome: string } }) =>
        Effect.succeed(input.route.eventHome === remote ? commands : []),
    } as unknown as Parameters<typeof pageStationReport>[0];
    const facts = {
      installationId: remote,
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
        remote,
        cc,
        [],
        [],
        "remote",
        true,
      ),
    );

    expect(batch.hasMore).toBe(true);
    expect(batch.records.length).toBeGreaterThan(0);
    expect(batch.records.length).toBeLessThan(commands.length);
    expect(
      mandatoryReportResponseReservationBytes(batch.records),
    ).toBeLessThanOrEqual(STATION_API_MAX_REPORT_BATCH_BYTES);
    expect(
      mandatoryReportResponseReservationBytes([
        ...batch.records,
        commands[batch.records.length]!,
      ]),
    ).toBeGreaterThan(STATION_API_MAX_REPORT_BATCH_BYTES);
  });

  it("pages the unacknowledged route prefix before mandatory outcomes", async () => {
    const routeRecords = Array.from(
      { length: 259 },
      (_, index) => commandCenterMailFact(index + 1),
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
      installationId: cc,
      receivedThrough: [],
      peerAcknowledgedThrough: [],
    } as Parameters<typeof pageStationReport>[1];
    const mandatory = routeRecords.slice(257);

    const first = await runEffect(
      pageStationReport(
        work,
        initialFacts,
        cc,
        remote,
        [],
        mandatory,
        "command-center",
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
          peerInstallationId: remote,
          acknowledgement: {
            eventHome: cc,
            entityHome: cc,
            through: routeRecords[255]!.id.seq,
          },
        },
      ],
    } as Parameters<typeof pageStationReport>[1];
    const second = await runEffect(
      pageStationReport(
        work,
        nextFacts,
        cc,
        remote,
        [],
        mandatory,
        "command-center",
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

  it("admits live Remote overseer mail without ordinary edges", () => {
    const topologyWithGrant = remoteOverseerTopology();
    const ccAdmission = makeStationWorkAdmission({
      ...topology("command-center"),
      documents: topologyWithGrant.documents,
      actorSeats: topologyWithGrant.actorSeats,
    });
    expect(ccAdmission.authorizeCommand(remoteOverseerMailboxCommand())).toEqual({
      _tag: "admitted",
    });

    const { overseer: _overseer, ...ordinaryRemoteSeat } = projectedRemoteOverseer;
    const ordinaryRemote = remoteOverseerTopology(ordinaryRemoteSeat);
    expect(
      makeStationWorkAdmission({
        ...topology("command-center"),
        documents: ordinaryRemote.documents,
        actorSeats: ordinaryRemote.actorSeats,
      }).authorizeCommand(remoteOverseerMailboxCommand()),
    ).toMatchObject({
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
