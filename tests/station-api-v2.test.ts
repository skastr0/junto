import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { CanvasDoc } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  STATION_API_PROTOCOL,
  StatusRequest,
  StatusResponse,
} from "../src/shared/station-api";
import {
  WorkCommand,
  WorkFact,
  type ActorRef,
  type WorkCommand as WorkCommandValue,
  type WorkFact as WorkFactValue,
} from "../src/shared/work-protocol";
import {
  makeStationWorkAdmission,
  selectStationReportRoutes,
  StationApiService,
  type StationApiPeerContext,
} from "../src/main/vellum/station/api";
import { ProjectedActorSeat } from "../src/main/vellum/station/actor-seat-compiler";
import {
  admitEnrolledStationPeer,
  dispatchStationApiRequest,
  type RunStationApi,
  type StationTransportAdmission,
} from "../src/main/vellum/station/dispatcher";
import { mintStationPeerRoute } from "../src/main/vellum/station/peer-exchange";

const strictDecode = { onExcessProperty: "error" } as const;
const observedAt = "2026-07-27T18:00:00.000Z";
const contentSha256 = "a".repeat(64);

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const cc = installation("cc-station-api-v2");
const remote = installation("remote-station-api-v2");
const otherRemote = installation("other-remote-station-api-v2");

const remoteActor: ActorRef = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(
    `seat_${"b".repeat(64)}`,
  ),
  canvasName: "factory",
  nodeId: "remote-actor",
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
    ],
    edges: connected
      ? [
          {
            id: "actor-tasks",
            fromNode: remoteActor.nodeId,
            toNode: "tasks",
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

type AdmissionTopology = Parameters<typeof makeStationWorkAdmission>[0];

const topology = (
  localRole: "command-center" | "remote",
  connected = true,
): AdmissionTopology => ({
  localInstallationId: localRole === "command-center" ? cc : remote,
  peerInstallationId: localRole === "command-center" ? remote : cc,
  localRole,
  localHostId: localRole === "command-center" ? "local" : "remote",
  documents: new Map([["factory", document(connected)]]),
  actorSeats: [projectedRemoteActor],
  installationByHostId: new Map([
    ["local", cc],
    ["remote", remote],
  ]),
});

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
      sink: { canvasName: "factory", nodeId: "tasks" },
    },
    operation: "message.append",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "message.append",
      message,
      sentBy,
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
    item: {
      kind: "message",
      itemId: message.messageId,
      sink: { canvasName: "factory", nodeId: "tasks" },
    },
    operation: "message.append",
    contentSha256,
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "message.append",
      message,
      sentBy: remoteActor,
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

describe("Station API v2 work routing", () => {
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

  it("admits the correlated CC mailbox fact only for the same local Remote actor edge", () => {
    const admitted = makeStationWorkAdmission(topology("remote"));
    expect(admitted.authorizeFact(messageFact())).toEqual({
      _tag: "admitted",
    });

    const disconnected = makeStationWorkAdmission(
      topology("remote", false),
    );
    expect(
      disconnected.authorizeFact(messageFact()),
    ).toMatchObject({
      _tag: "rejected",
      reason: "capability-denied",
    });
  });

  it("still admits Command Center operator mutations onto Remote-owned rows", () => {
    const admission = makeStationWorkAdmission(topology("remote"));

    expect(
      admission.authorizeCommand(taskDescribeCommand(cc, remote)),
    ).toEqual({ _tag: "admitted" });
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
