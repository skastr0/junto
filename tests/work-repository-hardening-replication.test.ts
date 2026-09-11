import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import type { Task } from "../src/shared/work-model";
import {
  AuthorialIntentFactBasis,
  ProjectedIntentFactBasis,
  WorkRecord,
  WorkSha256,
  type IntentFactBasis as IntentFactBasisValue,
  type WorkCommand as WorkCommandValue,
  type WorkRecord as WorkRecordValue,
} from "../src/shared/work-protocol";
import { compileStationPortfolioBody } from "../src/main/vellum-command/station/portfolio";
import { stationProjectionContentSha256 } from "../src/main/vellum-command/station/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum-command/state/engine";
import {
  authorialMaterialForTest,
  authorialTaskTopologyCapabilityForTest,
  currentProjectedTaskTopologyCapabilityForTest,
} from "./helpers/task-topology-authority";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";
import {
  workRecordContentSha256,
  WorkRepository,
  WorkRepositoryLive,
  type TaskDependencyScopeCapability,
} from "../src/main/vellum-command/work/repository";

const observedAt = "2026-08-26T18:00:00.000Z";
const topology: CanvasDoc = {
  nodes: [
    {
      id: "region-main",
      type: "group",
      x: 0,
      y: 0,
      width: 1_500,
      height: 800,
      label: "Main",
    },
    ...["tasks-main", "tasks-prerequisite", "tasks-dependent"].map(
      (id, index) => ({
        id,
        type: "text" as const,
        text: id,
        x: 40 + index * 320,
        y: 40,
        width: 260,
        height: 120,
        ether: { entity: { kind: "task" }, tasks: { items: [] } },
      }),
    ),
  ],
  edges: [],
};
const authorialBody = serializeCanvas(topology);
const authorialIntentSha256 = authorialMaterialForTest({
  generation: "1",
  documents: new Map([
    ["factory", { document: topology, rawBody: authorialBody }],
  ]),
}).intentSha256;
const projectedBody = compileStationPortfolioBody(
  new Map([["factory", topology]]),
  new Map(),
);
const projectedContentSha256 = stationProjectionContentSha256(projectedBody);
const authorialBasis = Schema.decodeUnknownSync(AuthorialIntentFactBasis)({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: authorialIntentSha256,
});
const projectedBasis = Schema.decodeUnknownSync(ProjectedIntentFactBasis)({
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
    closing.map(({ root }) => rm(root, { recursive: true, force: true })),
  );
});

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const actor = (digit: string, nodeId = `actor-${digit}`) => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`),
  canvasName: "factory",
  nodeId,
});

const message = (messageId: string, text: string, taskId: string) => ({
  messageId,
  role: "user" as const,
  parts: [{ kind: "text" as const, text }],
  taskId,
  contextId: "factory",
});

const task = (
  id: string,
  overrides: Partial<Task> = {},
): Task => ({
  id,
  state: "submitted",
  history: [message(`brief-${id}`, id, id)],
  admission: "auto",
  ...overrides,
});


const scope = (
  nodeId: string,
  basis: IntentFactBasisValue,
): TaskDependencyScopeCapability =>
  basis.kind === "authorial-intent"
    ? authorialTaskTopologyCapabilityForTest({
        basis,
        sink: { canvasName: "factory", nodeId },
        document: topology,
        rawBody: authorialBody,
      })
    : currentProjectedTaskTopologyCapabilityForTest({
        basis,
        sink: { canvasName: "factory", nodeId },
        rawBody: projectedBody,
      });

const openInstallation = async (
  local: InstallationIdValue,
  peers: ReadonlyArray<InstallationIdValue>,
  role: "command-center" | "remote",
) => {
  const root = join(
    tmpdir(),
    `vellum-command-work-hardening-${local}-${randomUUID()}`,
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
    state.transaction("test.seed-installation", (writer) => {
      for (const known of new Set([local, ...peers])) {
        writer.run(
          `INSERT INTO station_known_installations(
             installation_id, registered_at
           ) VALUES (?, ?)`,
          [known, observedAt],
        );
      }
      writer.run(
        `INSERT INTO station_installation(
           singleton, installation_id, created_at
         ) VALUES (1, ?, ?)`,
        [local, observedAt],
      );
      writer.run(
        `INSERT INTO station_configuration(
           singleton, role, host_id, agent_host_id,
           command_center_installation_id, supervised_preferred, configured_at
         ) VALUES (1, ?, ?, ?, ?, 1, ?)`,
        role === "command-center"
          ? [role, "local", null, null, observedAt]
          : [role, "remote", "remote", peers[0], observedAt],
      );
      seedCanvasAuthority(writer, {
        generation: authorialBasis.generation,
        documents: new Map([["factory", topology]]),
        at: observedAt,
      });
      writer.run(
        `INSERT INTO station_projection_versions(
           generation, content_sha256, source_canvas_generation,
           source_intent_sha256, body, created_at, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
        `INSERT INTO station_projection_head(
           singleton, generation, content_sha256
         ) VALUES (1, ?, ?)`,
        [projectedBasis.generation, projectedBasis.contentSha256],
      );
    }),
  );
  return {
    runtime,
    repository,
    state,
    basis: role === "command-center" ? authorialBasis : projectedBasis,
  };
};

const admitted = (taskDependencyScope?: TaskDependencyScopeCapability) => ({
  _tag: "admitted" as const,
  ...(taskDependencyScope === undefined ? {} : { taskDependencyScope }),
});

const accept = (
  repository: typeof WorkRepository.Service,
  senderInstallationId: InstallationIdValue,
  records: ReadonlyArray<WorkRecordValue>,
  options?: {
    readonly authorizeCommand?: Parameters<
      typeof repository.acceptRecords
    >[0]["authorizeCommand"];
    readonly authorizeFact?: Parameters<
      typeof repository.acceptRecords
    >[0]["authorizeFact"];
  },
) =>
  repository.acceptRecords({
    senderInstallationId,
    records,
    peerAcknowledgements: [],
    receivedAt: observedAt,
    authorizeCommand: options?.authorizeCommand ?? (() => admitted()),
    authorizeFact: options?.authorizeFact ?? (() => admitted()),
    admitResponse: () => admitted(),
  });

const reseal = (candidate: WorkRecordValue): WorkRecordValue => {
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

const pendingRouteCount = async (
  installationRuntime: Awaited<ReturnType<typeof openInstallation>>,
  eventHome: InstallationIdValue,
  entityHome: InstallationIdValue,
) =>
  installationRuntime.runtime.runPromise(
    installationRuntime.state.read("test.route-count", (reader) =>
      reader.get<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM work_commands
         WHERE event_home = ? AND entity_home = ?`,
        [eventHome, entityHome],
      )!.count,
    ),
  );

describe("WorkRepository hardening across replication", () => {
  it("fails closed for absent and wrong-sink dependency capabilities on commands", async () => {
    const ccId = installation("cc-command-capabilities");
    const remoteId = installation("remote-command-capabilities");
    const cc = await openInstallation(ccId, [remoteId], "command-center");
    const remote = await openInstallation(remoteId, [ccId], "remote");
    const sink = { canvasName: "factory", nodeId: "tasks-dependent" };
    const prerequisiteSink = {
      canvasName: "factory",
      nodeId: "tasks-prerequisite",
    };
    const prerequisite = task("command-prerequisite");
    await cc.runtime.runPromise(
      cc.repository.createTask({
        sink: prerequisiteSink,
        basis: authorialBasis,
        dependencyScope: scope(prerequisiteSink.nodeId, authorialBasis),
        task: prerequisite,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await cc.runtime.runPromise(
      cc.repository.claimLocalTask({
        sink: prerequisiteSink,
        basis: authorialBasis,
        dependencyScope: scope(prerequisiteSink.nodeId, authorialBasis),
        taskId: prerequisite.id,
        actor: actor("8"),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await cc.runtime.runPromise(
      cc.repository.transitionTask({
        sink: prerequisiteSink,
        basis: authorialBasis,
        dependencyScope: scope(prerequisiteSink.nodeId, authorialBasis),
        taskId: prerequisite.id,
        state: "completed",
        message: message("complete-command-prerequisite", "complete", prerequisite.id),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const authorizations: ReadonlyArray<
      TaskDependencyScopeCapability | undefined
    > = [
      undefined,
      scope(prerequisiteSink.nodeId, authorialBasis),
    ];
    for (const [index, taskDependencyScope] of authorizations.entries()) {
      const value = task(`command-capability-${index}`, {
        dependsOn: [prerequisite.id],
      });
      const command = await remote.runtime.runPromise(
        remote.repository.enqueueRemoteCommand({
          targetInstallationId: ccId,
          sink,
          item: { kind: "task", itemId: value.id, sink },
          action: { operation: "task.create", task: value },
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
      const result = await cc.runtime.runPromise(
        accept(cc.repository, remoteId, [command], {
          authorizeCommand: () => admitted(taskDependencyScope),
        }),
      );
      expect(result.emitted).toEqual([
        expect.objectContaining({
          recordType: "disposition",
          body: expect.objectContaining({ status: "rejected" }),
        }),
      ]);
    }

    const validTask = task("command-capability-valid", {
      dependsOn: [prerequisite.id],
    });
    const validCommand = await remote.runtime.runPromise(
      remote.repository.enqueueRemoteCommand({
        targetInstallationId: ccId,
        sink,
        item: { kind: "task", itemId: validTask.id, sink },
        action: { operation: "task.create", task: validTask },
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const accepted = await cc.runtime.runPromise(
      accept(cc.repository, remoteId, [validCommand], {
        authorizeCommand: () => admitted(scope(sink.nodeId, authorialBasis)),
      }),
    );
    expect(accepted.emitted).toEqual([
      expect.objectContaining({ recordType: "fact", operation: "task.create" }),
      expect.objectContaining({
        recordType: "disposition",
        body: expect.objectContaining({ status: "applied" }),
      }),
    ]);
  });

  it("honors the durable reservation snapshot when a prerequisite is requeued before return", async () => {
    const ccId = installation("cc-reservation-snapshot");
    const remoteId = installation("remote-reservation-snapshot");
    const cc = await openInstallation(ccId, [remoteId], "command-center");
    const remote = await openInstallation(remoteId, [ccId], "remote");
    const prerequisiteSink = {
      canvasName: "factory",
      nodeId: "tasks-prerequisite",
    };
    const dependentSink = { canvasName: "factory", nodeId: "tasks-dependent" };
    const prerequisiteScope = scope(prerequisiteSink.nodeId, authorialBasis);
    const dependentScope = scope(dependentSink.nodeId, authorialBasis);
    const prerequisite = task("reservation-prerequisite");
    const createdPrerequisite = await cc.runtime.runPromise(
      cc.repository.createTask({
        sink: prerequisiteSink,
        basis: authorialBasis,
        dependencyScope: scope(prerequisiteSink.nodeId, authorialBasis),
        task: prerequisite,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const claimedPrerequisite = await cc.runtime.runPromise(
      cc.repository.claimLocalTask({
        sink: prerequisiteSink,
        basis: authorialBasis,
        dependencyScope: prerequisiteScope,
        taskId: prerequisite.id,
        actor: actor("2"),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const completedPrerequisite = await cc.runtime.runPromise(
      cc.repository.transitionTask({
        sink: prerequisiteSink,
        basis: authorialBasis,
        dependencyScope: prerequisiteScope,
        taskId: prerequisite.id,
        state: "completed",
        message: message("complete-prerequisite", "complete", prerequisite.id),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const dependent = task("reservation-dependent", {
      dependsOn: [prerequisite.id],
    });
    const createdDependent = await cc.runtime.runPromise(
      cc.repository.createTask({
        sink: dependentSink,
        basis: authorialBasis,
        dependencyScope: dependentScope,
        task: dependent,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    await remote.runtime.runPromise(
      accept(
        remote.repository,
        ccId,
        [
          createdPrerequisite.record,
          claimedPrerequisite.record,
          completedPrerequisite.record,
        ],
        {
          authorizeFact: (fact) =>
            admitted(scope(fact.item.sink.nodeId, authorialBasis)),
        },
      ),
    );

    const reservation = await cc.runtime.runPromise(
      cc.repository.reserveRemoteTaskClaim({
        targetInstallationId: remoteId,
        sink: dependentSink,
        basis: authorialBasis,
        dependencyScope: dependentScope,
        taskId: dependent.id,
        actor: actor("3", "remote-worker"),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await cc.runtime.runPromise(
      cc.repository.transitionTask({
        sink: prerequisiteSink,
        basis: authorialBasis,
        dependencyScope: prerequisiteScope,
        taskId: prerequisite.id,
        state: "submitted",
        message: message("requeue-prerequisite", "requeue", prerequisite.id),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const remoteResult = await remote.runtime.runPromise(
      accept(remote.repository, ccId, [reservation], {
        authorizeCommand: () =>
          admitted(scope(dependentSink.nodeId, projectedBasis)),
      }),
    );
    const claimFact = remoteResult.emitted.find(
      (record) => record.recordType === "fact",
    );
    if (
      claimFact === undefined ||
      claimFact.recordType !== "fact" ||
      claimFact.body.operation !== "task.claim" ||
      claimFact.basis.kind !== "command"
    ) {
      throw new Error("claim fact missing");
    }

    const wrongHashFact = reseal({
      ...claimFact,
      basis: {
        ...claimFact.basis,
        commandSha256: Schema.decodeUnknownSync(WorkSha256)("f".repeat(64)),
      },
    });
    const wrongHash = await cc.runtime.runPromise(
      accept(cc.repository, remoteId, [wrongHashFact], {
        authorizeFact: () => admitted(),
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(wrongHash)).toBe(true);
    if (Result.isFailure(wrongHash)) {
      expect(wrongHash.failure).toMatchObject({ reason: "causal-conflict" });
    }

    const wrongActor = actor("4", "hostile-worker");
    const wrongResultFact = reseal({
      ...claimFact,
      body: {
        ...claimFact.body,
        claimedBy: wrongActor,
        task: {
          ...claimFact.body.task,
          claimedBy: wrongActor.seatId,
        },
      },
    });
    const wrongResult = await cc.runtime.runPromise(
      accept(cc.repository, remoteId, [wrongResultFact], {
        authorizeFact: () => admitted(),
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(wrongResult)).toBe(true);
    if (Result.isFailure(wrongResult)) {
      expect(wrongResult.failure).toMatchObject({ reason: "causal-conflict" });
    }

    // Move the prerequisite out of the dependent's region and advance the
    // authorial basis after execution but before the exact response returns.
    const changedTopology = structuredClone(topology);
    const changedPrerequisite = changedTopology.nodes.find(
      (node) => node.id === prerequisiteSink.nodeId,
    );
    if (changedPrerequisite === undefined) {
      throw new Error("changed prerequisite node missing");
    }
    await cc.runtime.runPromise(
      cc.state.transaction("test.advance-topology-before-return", (writer) => {
        seedCanvasAuthority(writer, {
          generation: "2",
          documents: new Map([["factory", changedTopology]]),
          at: observedAt,
        });
      }),
    );

    // No current capability is needed or consulted. The exact unresolved
    // reservation is the durable prior dependency authorization.
    await cc.runtime.runPromise(
      accept(cc.repository, remoteId, remoteResult.emitted, {
        authorizeFact: () => admitted(),
      }),
    );

    const dependentSnapshot = await cc.runtime.runPromise(
      cc.repository.readSnapshot(
        dependentSink.canvasName,
        dependentSink.nodeId,
      ),
    );
    expect(dependentSnapshot.tasks.items).toEqual([
      expect.objectContaining({
        id: dependent.id,
        state: "working",
        claimedBy: actor("3", "remote-worker").seatId,
      }),
    ]);
    const prerequisiteSnapshot = await cc.runtime.runPromise(
      cc.repository.readSnapshot(
        prerequisiteSink.canvasName,
        prerequisiteSink.nodeId,
      ),
    );
    expect(prerequisiteSnapshot.tasks.items).toEqual([
      expect.objectContaining({ id: prerequisite.id, state: "submitted" }),
    ]);
  });

  it("requires an exact retained-basis capability for dependency-bearing explicit facts", async () => {
    const ccId = installation("cc-explicit-fact-capability");
    const remoteId = installation("remote-explicit-fact-capability");
    const cc = await openInstallation(ccId, [remoteId], "command-center");
    const remote = await openInstallation(remoteId, [ccId], "remote");
    const prerequisiteSink = {
      canvasName: "factory",
      nodeId: "tasks-prerequisite",
    };
    const dependentSink = { canvasName: "factory", nodeId: "tasks-dependent" };
    const prerequisiteScope = scope(prerequisiteSink.nodeId, authorialBasis);
    const prerequisite = task("explicit-fact-prerequisite");
    const createdPrerequisite = await cc.runtime.runPromise(
      cc.repository.createTask({
        sink: prerequisiteSink,
        basis: authorialBasis,
        dependencyScope: scope(prerequisiteSink.nodeId, authorialBasis),
        task: prerequisite,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const claimedPrerequisite = await cc.runtime.runPromise(
      cc.repository.claimLocalTask({
        sink: prerequisiteSink,
        basis: authorialBasis,
        dependencyScope: prerequisiteScope,
        taskId: prerequisite.id,
        actor: actor("5"),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const completedPrerequisite = await cc.runtime.runPromise(
      cc.repository.transitionTask({
        sink: prerequisiteSink,
        basis: authorialBasis,
        dependencyScope: prerequisiteScope,
        taskId: prerequisite.id,
        state: "completed",
        message: message("complete-explicit-prerequisite", "complete", prerequisite.id),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const dependent = task("explicit-fact-dependent", {
      dependsOn: [prerequisite.id],
    });
    const createdDependent = await cc.runtime.runPromise(
      cc.repository.createTask({
        sink: dependentSink,
        basis: authorialBasis,
        dependencyScope: scope(dependentSink.nodeId, authorialBasis),
        task: dependent,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    await remote.runtime.runPromise(
      accept(
        remote.repository,
        ccId,
        [
          createdPrerequisite.record,
          claimedPrerequisite.record,
          completedPrerequisite.record,
        ],
        {
          authorizeFact: (fact) =>
            admitted(scope(fact.item.sink.nodeId, authorialBasis)),
        },
      ),
    );

    const invalidCapabilities: ReadonlyArray<
      TaskDependencyScopeCapability | undefined
    > = [
      undefined,
      scope(prerequisiteSink.nodeId, authorialBasis),
    ];
    for (const taskDependencyScope of invalidCapabilities) {
      const result = await remote.runtime.runPromise(
        accept(remote.repository, ccId, [createdDependent.record], {
          authorizeFact: () => admitted(taskDependencyScope),
        }).pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);
    }

    const accepted = await remote.runtime.runPromise(
      accept(remote.repository, ccId, [createdDependent.record], {
        authorizeFact: () =>
          admitted(scope(dependentSink.nodeId, authorialBasis)),
      }),
    );
    expect(accepted).toMatchObject({ accepted: 1, rejected: 0 });
    const snapshot = await remote.runtime.runPromise(
      remote.repository.readSnapshot(
        dependentSink.canvasName,
        dependentSink.nodeId,
      ),
    );
    expect(snapshot.tasks.items).toEqual([
      expect.objectContaining({
        id: dependent.id,
        dependsOn: [prerequisite.id],
      }),
    ]);
  });

});
