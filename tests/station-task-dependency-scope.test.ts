import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { CanvasDoc } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  STATION_API_PROTOCOL,
} from "../src/shared/station-api";
import {
  IntentFactBasis,
  WorkCommand,
  WorkFact,
  type ActorRef,
  type IntentFactBasis as IntentFactBasisValue,
  type WorkCommand as WorkCommandValue,
  type WorkFact as WorkFactValue,
} from "../src/shared/work-protocol";
import { ProjectedActorSeat } from "../src/main/vellum/station/actor-seat-compiler";
import {
  makeStationWorkAdmission,
  selectStationReportRoutes,
} from "../src/main/vellum/station/api";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import {
  workRecordContentSha256,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";

const strictDecode = { onExcessProperty: "error" } as const;
const observedAt = "2026-08-26T18:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-dependency-scope");
const remote = Schema.decodeUnknownSync(InstallationId)(
  "remote-dependency-scope",
);
const claimActor: ActorRef = {
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${"7".repeat(64)}`),
  canvasName: "factory",
  nodeId: "claim-actor",
};
const projectedClaimActor = Schema.decodeUnknownSync(
  ProjectedActorSeat,
  strictDecode,
)({
  seatId: claimActor.seatId,
  authorityInstallationId: remote,
  hostId: "remote",
  bindingId: "claim-actor-binding",
  agentKey: "remote:claim-actor",
  harness: "codex",
  primaryRef: {
    canvasName: claimActor.canvasName,
    nodeId: claimActor.nodeId,
  },
  refs: [{
    canvasName: claimActor.canvasName,
    nodeId: claimActor.nodeId,
  }],
});

const basis = (
  kind: IntentFactBasisValue["kind"],
  generation: string,
  digit: string,
): IntentFactBasisValue =>
  Schema.decodeUnknownSync(IntentFactBasis, strictDecode)({
    kind,
    generation,
    contentSha256: digit.repeat(64),
  });

const taskNode = (id: string, x: number, y: number) => ({
  id,
  type: "text" as const,
  x,
  y,
  width: 180,
  height: 80,
  text: id,
  ether: {
    entity: { kind: "task", name: id },
    host: "remote",
  },
});

const region = (id: string, x: number, y: number, width: number) => ({
  id,
  type: "group" as const,
  x,
  y,
  width,
  height: 300,
  label: id,
});

const topologyDoc = (sameRegion: boolean) =>
  Schema.decodeUnknownSync(CanvasDoc, strictDecode)({
    nodes: sameRegion
      ? [
        region("region-together", 0, 0, 700),
        taskNode("prerequisite-sink", 40, 60),
        taskNode("dependent-sink", 300, 60),
        taskNode("outside-sink", 800, 60),
      ]
      : [
        region("region-prerequisite", 0, 0, 240),
        region("region-dependent", 280, 0, 240),
        taskNode("prerequisite-sink", 30, 60),
        taskNode("dependent-sink", 310, 60),
      ],
    edges: [],
  });

const claimTopologyDoc = Schema.decodeUnknownSync(CanvasDoc, strictDecode)({
  nodes: [
    region("claim-region", 0, 0, 760),
    {
      ...taskNode("prerequisite-sink", 40, 60),
      ether: {
        entity: { kind: "task", name: "prerequisite-sink" },
        host: "local",
      },
    },
    {
      ...taskNode("dependent-sink", 300, 60),
      ether: {
        entity: { kind: "task", name: "dependent-sink" },
        host: "local",
      },
    },
    {
      id: claimActor.nodeId,
      type: "text",
      x: 540,
      y: 60,
      width: 180,
      height: 80,
      text: "Claim actor",
      ether: {
        entity: { kind: "agent", name: "remote:claim-actor" },
        host: "remote",
      },
    },
  ],
  edges: [{
    id: "claim-actor-contributes",
    fromNode: claimActor.nodeId,
    toNode: "dependent-sink",
    ether: { verb: "contributes" },
  }],
});

type AdmissionTopology = Parameters<typeof makeStationWorkAdmission>[0];

const topology = (
  doc: ReturnType<typeof topologyDoc>,
  intentBasis: IntentFactBasisValue,
): AdmissionTopology => ({
  localInstallationId: remote,
  peerInstallationId: cc,
  localRole: "remote",
  localHostId: "remote",
  intentBasis,
  documents: new Map([["factory", doc]]),
  actorSeats: [],
  installationByHostId: new Map<string, InstallationIdValue>([
    ["local", cc],
    ["remote", remote],
  ]),
});

const claimTopology = (
  intentBasis: IntentFactBasisValue,
): AdmissionTopology => ({
  localInstallationId: remote,
  peerInstallationId: cc,
  localRole: "remote",
  localHostId: "remote",
  intentBasis,
  documents: new Map([["factory", claimTopologyDoc]]),
  actorSeats: [projectedClaimActor],
  installationByHostId: new Map<string, InstallationIdValue>([
    ["local", cc],
    ["remote", remote],
  ]),
});

const commandCenterTopology = (
  doc: ReturnType<typeof topologyDoc>,
  intentBasis: IntentFactBasisValue,
): AdmissionTopology => ({
  localInstallationId: cc,
  peerInstallationId: remote,
  localRole: "command-center",
  localHostId: "local",
  intentBasis,
  documents: new Map([["factory", doc]]),
  actorSeats: [],
  installationByHostId: new Map<string, InstallationIdValue>([
    ["local", cc],
    ["remote", remote],
  ]),
});

const dependentCommand = (sequence = "1"): WorkCommandValue =>
  Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    protocol: "vellum/work/v2",
    id: {
      route: { eventHome: cc, entityHome: remote },
      seq: sequence,
    },
    recordType: "command",
    item: {
      kind: "task",
      itemId: "dependent-task",
      sink: { canvasName: "factory", nodeId: "dependent-sink" },
    },
    operation: "task.create",
    contentSha256: "f".repeat(64),
    originAt: observedAt,
    predecessor: null,
    body: {
      operation: "task.create",
      task: {
        id: "dependent-task",
        state: "submitted",
        history: [{
          messageId: "dependent-message",
          role: "user",
          parts: [{ kind: "text", text: "dependent" }],
          taskId: "dependent-task",
          contextId: "factory",
        }],
        metadata: { details: "dependent details" },
        dependsOn: ["prerequisite-task"],
      },
    },
  });

const taskCreateCommand = (input: {
  readonly taskId: string;
  readonly nodeId: string;
  readonly sequence: string;
  readonly dependsOn?: ReadonlyArray<string>;
}): WorkCommandValue => {
  const semantic = {
    protocol: "vellum/work/v2" as const,
    id: {
      route: { eventHome: cc, entityHome: remote },
      seq: input.sequence,
    },
    recordType: "command" as const,
    item: {
      kind: "task" as const,
      itemId: input.taskId,
      sink: { canvasName: "factory", nodeId: input.nodeId },
    },
    operation: "task.create" as const,
    predecessor: null,
    body: {
      operation: "task.create" as const,
      task: {
        id: input.taskId,
        state: "submitted" as const,
        history: [{
          messageId: `message-${input.taskId}`,
          role: "user" as const,
          parts: [{ kind: "text" as const, text: input.taskId }],
          taskId: input.taskId,
          contextId: "factory",
        }],
        metadata: { details: `${input.taskId} details` },
        ...(input.dependsOn === undefined
          ? {}
          : { dependsOn: input.dependsOn }),
      },
    },
  };
  const candidate = Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    ...semantic,
    originAt: observedAt,
    contentSha256: "0".repeat(64),
  });
  const {
    contentSha256: placeholderSha256,
    originAt: displayTimestamp,
    ...recordSemantic
  } = candidate;
  void placeholderSha256;
  void displayTimestamp;
  return Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    ...candidate,
    contentSha256: workRecordContentSha256(recordSemantic),
  });
};

const dependentClaimCommand = (): WorkCommandValue => {
  const semantic = {
    protocol: "vellum/work/v2" as const,
    id: {
      route: { eventHome: cc, entityHome: remote },
      seq: "1",
    },
    recordType: "command" as const,
    item: {
      kind: "task" as const,
      itemId: "adopted-dependent-task",
      sink: { canvasName: "factory", nodeId: "dependent-sink" },
    },
    operation: "task.claim" as const,
    predecessor: null,
    body: {
      operation: "task.claim" as const,
      sourceQueueHome: cc,
      sourcePredecessor: {
        route: { eventHome: cc, entityHome: cc },
        seq: "9",
      },
      sourceTask: {
        id: "adopted-dependent-task",
        state: "submitted" as const,
        history: [{
          messageId: "message-adopted-dependent-task",
          role: "user" as const,
          parts: [{ kind: "text" as const, text: "adopt dependency" }],
          taskId: "adopted-dependent-task",
          contextId: "factory",
        }],
        metadata: { details: "adopt dependent details" },
        dependsOn: ["prerequisite-task"],
      },
      sink: { canvasName: "factory", nodeId: "dependent-sink" },
      actor: claimActor,
      targetHome: remote,
    },
  };
  const candidate = Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    ...semantic,
    originAt: observedAt,
    contentSha256: "0".repeat(64),
  });
  const {
    contentSha256: placeholderSha256,
    originAt: displayTimestamp,
    ...recordSemantic
  } = candidate;
  void placeholderSha256;
  void displayTimestamp;
  return Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    ...candidate,
    contentSha256: workRecordContentSha256(recordSemantic),
  });
};

const correlatedClaimFact = (): WorkFactValue => {
  const command = dependentClaimCommand();
  if (command.body.operation !== "task.claim") {
    throw new Error("claim command fixture changed operation");
  }
  const semantic = {
    protocol: "vellum/work/v2" as const,
    id: {
      route: { eventHome: remote, entityHome: remote },
      seq: "1",
    },
    recordType: "fact" as const,
    item: command.item,
    operation: "task.claim" as const,
    basis: {
      kind: "command" as const,
      command: command.id,
      commandSha256: command.contentSha256,
    },
    predecessor: null,
    body: {
      operation: "task.claim" as const,
      task: {
        ...command.body.sourceTask,
        state: "working" as const,
        claimedBy: claimActor.seatId,
      },
      claimedBy: claimActor,
      previousHome: cc,
    },
  };
  const candidate = Schema.decodeUnknownSync(WorkFact, strictDecode)({
    ...semantic,
    originAt: observedAt,
    contentSha256: "0".repeat(64),
  });
  const {
    contentSha256: placeholderSha256,
    originAt: displayTimestamp,
    ...recordSemantic
  } = candidate;
  void placeholderSha256;
  void displayTimestamp;
  return Schema.decodeUnknownSync(WorkFact, strictDecode)({
    ...candidate,
    contentSha256: workRecordContentSha256(recordSemantic),
  });
};

const dependentFact = (
  intentBasis: IntentFactBasisValue,
  sequence = "1",
): WorkFactValue =>
  Schema.decodeUnknownSync(WorkFact, strictDecode)({
    protocol: "vellum/work/v2",
    id: {
      route: { eventHome: remote, entityHome: remote },
      seq: sequence,
    },
    recordType: "fact",
    item: {
      kind: "task",
      itemId: "dependent-task",
      sink: { canvasName: "factory", nodeId: "dependent-sink" },
    },
    operation: "task.create",
    contentSha256: "e".repeat(64),
    originAt: observedAt,
    predecessor: null,
    basis: intentBasis,
    body: dependentCommand().body,
  });

const taskFact = (input: {
  readonly taskId: string;
  readonly nodeId: string;
  readonly sequence: string;
  readonly intentBasis: IntentFactBasisValue;
  readonly dependsOn?: ReadonlyArray<string>;
}): WorkFactValue => {
  const candidate = {
    protocol: "vellum/work/v2" as const,
    id: {
      route: { eventHome: remote, entityHome: remote },
      seq: input.sequence,
    },
    recordType: "fact" as const,
    item: {
      kind: "task" as const,
      itemId: input.taskId,
      sink: { canvasName: "factory", nodeId: input.nodeId },
    },
    operation: "task.create" as const,
    originAt: observedAt,
    predecessor: null,
    basis: input.intentBasis,
    body: {
      operation: "task.create" as const,
      task: {
        id: input.taskId,
        state: "submitted" as const,
        history: [{
          messageId: `message-${input.taskId}`,
          role: "user" as const,
          parts: [{ kind: "text" as const, text: input.taskId }],
          taskId: input.taskId,
          contextId: "factory",
        }],
        metadata: { details: `${input.taskId} details` },
        ...(input.dependsOn === undefined
          ? {}
          : { dependsOn: [...input.dependsOn] }),
      },
    },
  };
  const decoded = Schema.decodeUnknownSync(WorkFact, strictDecode)({
    ...candidate,
    contentSha256: "0".repeat(64),
  });
  const {
    contentSha256: placeholderSha256,
    originAt: displayTimestamp,
    ...semantic
  } = decoded;
  void placeholderSha256;
  void displayTimestamp;
  return Schema.decodeUnknownSync(WorkFact, strictDecode)({
    ...decoded,
    contentSha256: workRecordContentSha256(semantic),
  });
};

const openRepository = async (
  projectedBasis: IntentFactBasisValue,
  localRole: "command-center" | "remote" = "command-center",
) => {
  if (projectedBasis.kind !== "projected-intent") {
    throw new Error("repository fixture requires projected intent");
  }
  const root = join(
    tmpdir(),
    `vellum-command-station-dependency-scope-${randomUUID()}`,
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "vellum-command.db")),
    ),
  );
  const repository = await runtime.runPromise(WorkRepository);
  const state = await runtime.runPromise(StateEngine);
  await runtime.runPromise(
    state.transaction("test.seed-station-scope", (writer) => {
      for (const id of [cc, remote]) {
        writer.run(
          `INSERT INTO station_known_installations(
             installation_id, registered_at
           ) VALUES (?, ?)`,
          [id, observedAt],
        );
      }
      const localInstallationId = localRole === "remote" ? remote : cc;
      writer.run(
        `INSERT INTO station_installation(
           singleton, installation_id, created_at
         ) VALUES (1, ?, ?)`,
        [localInstallationId, observedAt],
      );
      writer.run(
        `INSERT INTO station_configuration(
           singleton, role, host_id, agent_host_id,
           command_center_installation_id, supervised_preferred, configured_at
         ) VALUES (1, ?, ?, ?, ?, 1, ?)`,
        localRole === "remote"
          ? ["remote", "remote", "remote", cc, observedAt]
          : ["command-center", "local", null, null, observedAt],
      );
      writer.run(
        `INSERT INTO station_projection_versions(
           generation, content_sha256, source_canvas_generation,
           source_intent_sha256, body, created_at, received_at
         ) VALUES (?, ?, '1', ?, '{}', ?, ?)`,
        [
          projectedBasis.generation,
          projectedBasis.contentSha256,
          "a".repeat(64),
          observedAt,
          observedAt,
        ],
      );
      if (localRole === "remote") {
        writer.run(
          `INSERT INTO station_projection_head(
             singleton, generation, content_sha256
           ) VALUES (1, ?, ?)`,
          [projectedBasis.generation, projectedBasis.contentSha256],
        );
      }
    }),
  );
  return { root, runtime, repository };
};

const acceptFacts = (
  repository: Awaited<ReturnType<typeof openRepository>>["repository"],
  facts: ReadonlyArray<WorkFactValue>,
  authorization: ReturnType<typeof makeStationWorkAdmission>,
) =>
  repository.acceptRecords({
    senderInstallationId: remote,
    records: facts,
    peerAcknowledgements: [],
    receivedAt: observedAt,
    authorizeCommand: () => ({ _tag: "admitted" }),
    authorizeFact: authorization.authorizeFact,
    admitResponse: () => ({ _tag: "admitted" }),
  });

const acceptCommands = (
  repository: Awaited<ReturnType<typeof openRepository>>["repository"],
  commands: ReadonlyArray<WorkCommandValue>,
  authorization: ReturnType<typeof makeStationWorkAdmission>,
) =>
  repository.acceptRecords({
    senderInstallationId: cc,
    records: commands,
    peerAcknowledgements: [],
    receivedAt: observedAt,
    authorizeCommand: authorization.authorizeCommand,
    authorizeFact: authorization.authorizeFact,
    admitResponse: () => ({ _tag: "admitted" }),
  });

describe("Station dependency scope admission", () => {
  it("admits current projected commands only across same-region Task sinks", async () => {
    const currentBasis = basis("projected-intent", "15", "a");
    const prerequisite = taskCreateCommand({
      taskId: "prerequisite-task",
      nodeId: "prerequisite-sink",
      sequence: "1",
    });
    const dependent = taskCreateCommand({
      taskId: "dependent-task",
      nodeId: "dependent-sink",
      sequence: "2",
      dependsOn: ["prerequisite-task"],
    });

    const sameRegion = await openRepository(currentBasis, "remote");
    try {
      const admission = makeStationWorkAdmission(
        topology(topologyDoc(true), currentBasis),
      );
      await sameRegion.runtime.runPromise(
        acceptCommands(
          sameRegion.repository,
          [prerequisite, dependent],
          admission,
        ),
      );
      const snapshot = await sameRegion.runtime.runPromise(
        sameRegion.repository.readSnapshot("factory", "dependent-sink"),
      );
      expect(snapshot.tasks.items.map((task) => task.id)).toContain(
        "dependent-task",
      );
    } finally {
      await sameRegion.runtime.dispose();
      await rm(sameRegion.root, { recursive: true, force: true });
    }

    const crossRegion = await openRepository(currentBasis, "remote");
    try {
      const admission = makeStationWorkAdmission(
        topology(topologyDoc(false), currentBasis),
      );
      const result = await crossRegion.runtime.runPromise(
        acceptCommands(
          crossRegion.repository,
          [prerequisite, dependent],
          admission,
        ),
      );
      expect(result).toMatchObject({ accepted: 1, rejected: 1 });
      expect(result.emitted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            recordType: "disposition",
            body: expect.objectContaining({
              status: "rejected",
              message: expect.stringContaining("missing task"),
            }),
          }),
        ]),
      );
      const snapshot = await crossRegion.runtime.runPromise(
        crossRegion.repository.readSnapshot("factory", "dependent-sink"),
      );
      expect(snapshot.tasks.items).toEqual([]);
    } finally {
      await crossRegion.runtime.dispose();
      await rm(crossRegion.root, { recursive: true, force: true });
    }
  });

  it("admits a dependent cross-home claim command with current scope", async () => {
    const currentBasis = basis("projected-intent", "16", "b");
    const opened = await openRepository(currentBasis, "remote");
    try {
      const command = dependentClaimCommand();
      const result = await opened.runtime.runPromise(
        acceptCommands(
          opened.repository,
          [command],
          makeStationWorkAdmission(claimTopology(currentBasis)),
        ),
      );
      expect(result).toMatchObject({ accepted: 1, rejected: 0 });
      const snapshot = await opened.runtime.runPromise(
        opened.repository.readSnapshot("factory", "dependent-sink"),
      );
      expect(snapshot.tasks.items).toEqual([
        expect.objectContaining({
          id: "adopted-dependent-task",
          state: "working",
          claimedBy: claimActor.seatId,
          dependsOn: ["prerequisite-task"],
        }),
      ]);
    } finally {
      await opened.runtime.dispose();
      await rm(opened.root, { recursive: true, force: true });
    }
  });

  it("admits an exact command-basis fact without mutable topology", () => {
    const authorization = makeStationWorkAdmission({
      localInstallationId: cc,
      peerInstallationId: remote,
      localRole: "command-center",
      localHostId: "local",
      intentBasis: basis("authorial-intent", "17", "c"),
      documents: new Map(),
      actorSeats: [],
      installationByHostId: new Map<string, InstallationIdValue>([
        ["local", cc],
        ["remote", remote],
      ]),
    }).authorizeFact(correlatedClaimFact());

    expect(authorization._tag).toBe("admitted");
  });

  it("requires a retained projected fact to name the exact retained basis", () => {
    const retainedBasis = basis("projected-intent", "11", "b");
    const fact = dependentFact(retainedBasis);
    const retained = makeStationWorkAdmission(
      commandCenterTopology(topologyDoc(true), retainedBasis),
    ).authorizeFact(fact);
    expect(retained._tag).toBe("admitted");

    expect(
      makeStationWorkAdmission(
        commandCenterTopology(
          topologyDoc(true),
          basis("authorial-intent", "12", "c"),
        ),
      ).authorizeFact(fact),
    ).toMatchObject({
      _tag: "rejected",
      reason: "projection-conflict",
    });
  });

  it("materializes a retained same-region fact through repository admission", async () => {
    const retainedBasis = basis("projected-intent", "20", "d");
    const opened = await openRepository(retainedBasis);
    try {
      const admission = makeStationWorkAdmission(
        commandCenterTopology(topologyDoc(true), retainedBasis),
      );
      const prerequisite = taskFact({
        taskId: "prerequisite-task",
        nodeId: "prerequisite-sink",
        sequence: "1",
        intentBasis: retainedBasis,
      });
      const dependent = taskFact({
        taskId: "dependent-task",
        nodeId: "dependent-sink",
        sequence: "2",
        intentBasis: retainedBasis,
        dependsOn: ["prerequisite-task"],
      });

      await opened.runtime.runPromise(
        acceptFacts(opened.repository, [prerequisite, dependent], admission),
      );
      const snapshot = await opened.runtime.runPromise(
        opened.repository.readSnapshot("factory", "dependent-sink"),
      );
      expect(snapshot.tasks.items.map((task) => task.id)).toContain(
        "dependent-task",
      );
    } finally {
      await opened.runtime.dispose();
      await rm(opened.root, { recursive: true, force: true });
    }
  });

  it("refuses a retained cross-region dependency without current-intent widening", async () => {
    const retainedBasis = basis("projected-intent", "21", "e");
    const currentBasis = basis("authorial-intent", "22", "f");
    const opened = await openRepository(retainedBasis);
    try {
      const retained = makeStationWorkAdmission(
        commandCenterTopology(topologyDoc(false), retainedBasis),
      );
      const current = makeStationWorkAdmission(
        commandCenterTopology(topologyDoc(true), currentBasis),
      );
      const prerequisite = taskFact({
        taskId: "prerequisite-task",
        nodeId: "prerequisite-sink",
        sequence: "1",
        intentBasis: retainedBasis,
      });
      await opened.runtime.runPromise(
        acceptFacts(opened.repository, [prerequisite], retained),
      );

      const dependent = taskFact({
        taskId: "dependent-task",
        nodeId: "dependent-sink",
        sequence: "2",
        intentBasis: retainedBasis,
        dependsOn: ["prerequisite-task"],
      });
      expect(current.authorizeFact(dependent)).toMatchObject({
        _tag: "rejected",
        reason: "projection-conflict",
      });
      await expect(
        opened.runtime.runPromise(
          acceptFacts(opened.repository, [dependent], retained),
        ),
      ).rejects.toThrow(/missing task/);
      const snapshot = await opened.runtime.runPromise(
        opened.repository.readSnapshot("factory", "dependent-sink"),
      );
      expect(snapshot.tasks.items).toEqual([]);
    } finally {
      await opened.runtime.dispose();
      await rm(opened.root, { recursive: true, force: true });
    }
  });

  it("keeps Station protocol 1 selection and command bytes unchanged", () => {
    const command = dependentCommand("3");
    const before = Buffer.from(JSON.stringify(command));

    const authorization = makeStationWorkAdmission(
      topology(
        topologyDoc(true),
        basis("projected-intent", "10", "a"),
      ),
    ).authorizeCommand(command);

    expect(authorization._tag).toBe("admitted");
    expect(Buffer.from(JSON.stringify(command))).toEqual(before);
    expect(STATION_API_PROTOCOL).toBe("vellum-command/station-api/v1");
    expect(selectStationReportRoutes("remote", remote, cc)).toEqual({
      facts: { eventHome: remote, entityHome: remote },
      commands: { eventHome: remote, entityHome: cc },
    });
  });
});
