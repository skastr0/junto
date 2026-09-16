import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CanvasDoc, serializeCanvas } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  STATION_API_PROTOCOL,
} from "../src/shared/station-api";
import {
  AuthorialIntentFactBasis,
  ProjectedIntentFactBasis,
  WorkCommand,
  WorkFact,
  type ActorRef,
  type AuthorialIntentFactBasis as AuthorialIntentFactBasisValue,
  type IntentFactBasis as IntentFactBasisValue,
  type ProjectedIntentFactBasis as ProjectedIntentFactBasisValue,
  type WorkCommand as WorkCommandValue,
  type WorkFact as WorkFactValue,
} from "../src/shared/work-protocol";
import {
  deriveActorSeatId,
  ProjectedActorSeat,
} from "../src/main/vellum-command/station/actor-seat-compiler";
import { STATION_PORTFOLIO_PROTOCOL } from "../src/main/vellum-command/station/portfolio";
import { stationProjectionContentSha256 } from "../src/main/vellum-command/station/repository";
import { authorialMaterialForTest } from "./helpers/task-topology-authority";
import {
  makeStationWorkAdmission,
  selectStationReportRoutes,
} from "../src/main/vellum-command/station/api";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum-command/state/engine";
import {
  workRecordContentSha256,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum-command/work/repository";

const strictDecode = { onExcessProperty: "error" } as const;
const observedAt = "2026-08-26T18:00:00.000Z";
const cc = Schema.decodeUnknownSync(InstallationId)("cc-dependency-scope");
const remote = Schema.decodeUnknownSync(InstallationId)(
  "remote-dependency-scope",
);
const claimActorBindingId = "claim-actor-binding";
const claimActor: ActorRef = {
  seatId: deriveActorSeatId(remote, claimActorBindingId),
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
  bindingId: claimActorBindingId,
  agentKey: "remote:claim-actor",
  harness: "codex",
  launch: { kind: "harness", argv: ["codex"] },
  primaryRef: {
    canvasName: claimActor.canvasName,
    nodeId: claimActor.nodeId,
  },
  refs: [{
    canvasName: claimActor.canvasName,
    nodeId: claimActor.nodeId,
  }],
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
        terminal: {
          bindingId: claimActorBindingId,
          harness: "codex",
          launch: { kind: "harness", argv: ["codex"] },
        },
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

type ProjectedFixture = {
  readonly kind: "projected";
  readonly basis: ProjectedIntentFactBasisValue;
  readonly rawBody: string;
};

type AuthorialFixture = {
  readonly kind: "authorial";
  readonly basis: AuthorialIntentFactBasisValue;
  readonly authority: ReturnType<typeof authorialMaterialForTest>;
};

const projectedFixture = (
  doc: ReturnType<typeof topologyDoc>,
  generation: string,
  actorSeats: ReadonlyArray<typeof projectedClaimActor> = [],
): ProjectedFixture => {
  const rawBody = JSON.stringify({
    protocol: STATION_PORTFOLIO_PROTOCOL,
    documents: [{ name: "factory", body: serializeCanvas(doc) }],
    actorSeats,
  });
  return {
    kind: "projected",
    rawBody,
    basis: Schema.decodeUnknownSync(ProjectedIntentFactBasis, strictDecode)({
      kind: "projected-intent",
      generation,
      contentSha256: stationProjectionContentSha256(rawBody),
    }),
  };
};

const authorialFixture = (
  doc: ReturnType<typeof topologyDoc>,
  generation: string,
): AuthorialFixture => {
  const rawBody = serializeCanvas(doc);
  const authority = authorialMaterialForTest({
    generation,
    documents: new Map([["factory", { document: doc, rawBody }]]),
  });
  return {
    kind: "authorial",
    authority,
    basis: Schema.decodeUnknownSync(AuthorialIntentFactBasis, strictDecode)({
      kind: "authorial-intent",
      generation,
      contentSha256: authority.intentSha256,
    }),
  };
};

type AdmissionTopology = Parameters<typeof makeStationWorkAdmission>[0];

const topology = (
  doc: ReturnType<typeof topologyDoc>,
  fixture: ProjectedFixture,
): AdmissionTopology => ({
  localInstallationId: remote,
  peerInstallationId: cc,
  localRole: "remote",
  localHostId: "remote",
  intentBasis: fixture.basis,
  taskTopologyMaterial: {
    kind: "projected-current",
    rawBody: fixture.rawBody,
    generation: fixture.basis.generation,
    contentSha256: fixture.basis.contentSha256,
  },
  documents: new Map([["factory", doc]]),
  actorSeats: [],
  installationByHostId: new Map<string, InstallationIdValue>([
    ["local", cc],
    ["remote", remote],
  ]),
});

const claimTopology = (
  fixture: ProjectedFixture,
): AdmissionTopology => ({
  localInstallationId: remote,
  peerInstallationId: cc,
  localRole: "remote",
  localHostId: "remote",
  intentBasis: fixture.basis,
  taskTopologyMaterial: {
    kind: "projected-current",
    rawBody: fixture.rawBody,
    generation: fixture.basis.generation,
    contentSha256: fixture.basis.contentSha256,
  },
  documents: new Map([["factory", claimTopologyDoc]]),
  actorSeats: [projectedClaimActor],
  installationByHostId: new Map<string, InstallationIdValue>([
    ["local", cc],
    ["remote", remote],
  ]),
});

const commandCenterTopology = (
  doc: ReturnType<typeof topologyDoc>,
  fixture: ProjectedFixture | AuthorialFixture,
): AdmissionTopology => ({
  localInstallationId: cc,
  peerInstallationId: remote,
  localRole: "command-center",
  localHostId: "local",
  intentBasis: fixture.basis,
  taskTopologyMaterial: fixture.kind === "projected"
    ? {
        kind: "projected-retained",
        rawBody: fixture.rawBody,
        generation: fixture.basis.generation,
        contentSha256: fixture.basis.contentSha256,
      }
    : { kind: "authorial-current", authority: fixture.authority },
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

const independentClaimCommand = (): WorkCommandValue => {
  const dependent = dependentClaimCommand();
  if (dependent.body.operation !== "task.claim") {
    throw new Error("claim command fixture changed operation");
  }
  const { dependsOn: _dependsOn, ...sourceTask } = dependent.body.sourceTask;
  const candidate = Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    ...dependent,
    body: { ...dependent.body, sourceTask },
    contentSha256: "0".repeat(64),
  });
  const {
    contentSha256: placeholderSha256,
    originAt: displayTimestamp,
    ...semantic
  } = candidate;
  void placeholderSha256;
  void displayTimestamp;
  return Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    ...candidate,
    contentSha256: workRecordContentSha256(semantic),
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
  projected: ProjectedFixture,
  localRole: "command-center" | "remote" = "command-center",
) => {
  const projectedBasis = projected.basis;
  const root = join(
    tmpdir(),
    `vellum-command-station-dependency-scope-${randomUUID()}`,
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "junto.db")),
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
         ) VALUES (?, ?, '1', ?, ?, ?, ?)`,
        [
          projectedBasis.generation,
          projectedBasis.contentSha256,
          "a".repeat(64),
          projected.rawBody,
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
    const sameRegionDoc = topologyDoc(true);
    const sameRegionFixture = projectedFixture(sameRegionDoc, "15");
    const crossRegionDoc = topologyDoc(false);
    const crossRegionFixture = projectedFixture(crossRegionDoc, "15");
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

    const sameRegion = await openRepository(sameRegionFixture, "remote");
    try {
      const admission = makeStationWorkAdmission(
        topology(sameRegionDoc, sameRegionFixture),
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

    const crossRegion = await openRepository(crossRegionFixture, "remote");
    try {
      const admission = makeStationWorkAdmission(
        topology(crossRegionDoc, crossRegionFixture),
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
    const currentFixture = projectedFixture(
      claimTopologyDoc,
      "16",
      [projectedClaimActor],
    );
    const opened = await openRepository(currentFixture, "remote");
    try {
      const command = dependentClaimCommand();
      const result = await opened.runtime.runPromise(
        acceptCommands(
          opened.repository,
          [command],
          makeStationWorkAdmission(claimTopology(currentFixture)),
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

  it("rejects a zero-dependency Remote claim without topology authority", async () => {
    const fixture = projectedFixture(
      claimTopologyDoc,
      "15",
      [projectedClaimActor],
    );
    const opened = await openRepository(fixture, "remote");
    try {
      const result = await opened.runtime.runPromise(
        opened.repository.acceptRecords({
          senderInstallationId: cc,
          records: [independentClaimCommand()],
          peerAcknowledgements: [],
          receivedAt: observedAt,
          authorizeCommand: () => ({ _tag: "admitted" }),
          authorizeFact: () => ({ _tag: "admitted" }),
          admitResponse: () => ({ _tag: "admitted" }),
        }),
      );
      expect(result).toMatchObject({ accepted: 0, rejected: 1 });
      expect(result.emitted).toEqual([
        expect.objectContaining({
          recordType: "disposition",
          body: expect.objectContaining({
            status: "rejected",
            message: expect.stringContaining("authentic process-local capability"),
          }),
        }),
      ]);
      const snapshot = await opened.runtime.runPromise(
        opened.repository.readSnapshot("factory", "dependent-sink"),
      );
      expect(snapshot.tasks.items).toEqual([]);
    } finally {
      await opened.runtime.dispose();
      await rm(opened.root, { recursive: true, force: true });
    }
  });

  it("rejects a zero-dependency claim after its captured projection is replaced", async () => {
    const oldFixture = projectedFixture(
      claimTopologyDoc,
      "16",
      [projectedClaimActor],
    );
    const newFixture = projectedFixture(
      claimTopologyDoc,
      "17",
      [projectedClaimActor],
    );
    const opened = await openRepository(oldFixture, "remote");
    try {
      const command = independentClaimCommand();
      const staleAdmission = makeStationWorkAdmission(
        claimTopology(oldFixture),
      );
      expect(staleAdmission.authorizeCommand(command)).toMatchObject({
        _tag: "admitted",
        taskDependencyScope: expect.any(Object),
      });

      const state = await opened.runtime.runPromise(StateEngine);
      await opened.runtime.runPromise(
        state.transaction("test.advance-projection-head", (writer) => {
          writer.run(
            `INSERT INTO station_projection_versions(
               generation, content_sha256, source_canvas_generation,
               source_intent_sha256, body, created_at, received_at
             ) VALUES (?, ?, '2', ?, ?, ?, ?)`,
            [
              newFixture.basis.generation,
              newFixture.basis.contentSha256,
              "d".repeat(64),
              newFixture.rawBody,
              observedAt,
              observedAt,
            ],
          );
          writer.run(
            `UPDATE station_projection_head
             SET generation = ?, content_sha256 = ?
             WHERE singleton = 1`,
            [
              newFixture.basis.generation,
              newFixture.basis.contentSha256,
            ],
          );
        }),
      );

      const result = await opened.runtime.runPromise(
        acceptCommands(opened.repository, [command], staleAdmission),
      );
      expect(result).toMatchObject({ accepted: 0, rejected: 1 });
      expect(result.emitted).toEqual([
        expect.objectContaining({
          recordType: "disposition",
          body: expect.objectContaining({
            status: "rejected",
            message: expect.stringContaining("current retained projection"),
          }),
        }),
      ]);
      const snapshot = await opened.runtime.runPromise(
        opened.repository.readSnapshot("factory", "dependent-sink"),
      );
      expect(snapshot.tasks.items).toEqual([]);
    } finally {
      await opened.runtime.dispose();
      await rm(opened.root, { recursive: true, force: true });
    }
  });

  it("admits an exact command-basis fact without mutable topology", () => {
    const doc = topologyDoc(true);
    const authorization = makeStationWorkAdmission(
      commandCenterTopology(doc, authorialFixture(doc, "17")),
    ).authorizeFact(correlatedClaimFact());

    expect(authorization._tag).toBe("admitted");
  });

  it("requires a retained projected fact to name the exact retained basis", () => {
    const retainedDoc = topologyDoc(true);
    const retainedFixture = projectedFixture(retainedDoc, "11");
    const retainedBasis = retainedFixture.basis;
    const fact = dependentFact(retainedBasis);
    const retained = makeStationWorkAdmission(
      commandCenterTopology(retainedDoc, retainedFixture),
    ).authorizeFact(fact);
    expect(retained._tag).toBe("admitted");

    expect(
      makeStationWorkAdmission(
        commandCenterTopology(
          retainedDoc,
          authorialFixture(retainedDoc, "12"),
        ),
      ).authorizeFact(fact),
    ).toMatchObject({
      _tag: "rejected",
      reason: "projection-conflict",
    });
  });

  it("rejects an exact projected body that was never retained", async () => {
    const storedDoc = topologyDoc(true);
    const storedFixture = projectedFixture(storedDoc, "30");
    const unretainedDoc = topologyDoc(false);
    const unretainedFixture = projectedFixture(unretainedDoc, "31");
    const opened = await openRepository(storedFixture);
    try {
      const admission = makeStationWorkAdmission(
        commandCenterTopology(unretainedDoc, unretainedFixture),
      );
      const unretainedFact = taskFact({
        taskId: "unretained-task",
        nodeId: "dependent-sink",
        sequence: "1",
        intentBasis: unretainedFixture.basis,
      });

      await expect(
        opened.runtime.runPromise(
          acceptFacts(opened.repository, [unretainedFact], admission),
        ),
      ).rejects.toThrow(/not an exact retained projection/);
      const snapshot = await opened.runtime.runPromise(
        opened.repository.readSnapshot("factory", "dependent-sink"),
      );
      expect(snapshot.tasks.items).toEqual([]);
    } finally {
      await opened.runtime.dispose();
      await rm(opened.root, { recursive: true, force: true });
    }
  });

  it("materializes a retained same-region fact through repository admission", async () => {
    const retainedDoc = topologyDoc(true);
    const retainedFixture = projectedFixture(retainedDoc, "20");
    const retainedBasis = retainedFixture.basis;
    const opened = await openRepository(retainedFixture);
    try {
      const admission = makeStationWorkAdmission(
        commandCenterTopology(retainedDoc, retainedFixture),
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
    const retainedDoc = topologyDoc(false);
    const retainedFixture = projectedFixture(retainedDoc, "21");
    const retainedBasis = retainedFixture.basis;
    const currentDoc = topologyDoc(true);
    const currentFixture = authorialFixture(currentDoc, "22");
    const opened = await openRepository(retainedFixture);
    try {
      const retained = makeStationWorkAdmission(
        commandCenterTopology(retainedDoc, retainedFixture),
      );
      const current = makeStationWorkAdmission(
        commandCenterTopology(currentDoc, currentFixture),
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

    const doc = topologyDoc(true);
    const authorization = makeStationWorkAdmission(
      topology(doc, projectedFixture(doc, "10")),
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
