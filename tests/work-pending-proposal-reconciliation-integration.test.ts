import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { CanvasDoc } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  ConfigureRequest,
  LogicalSequence as StationLogicalSequence,
  PairRequest,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationHostId,
} from "../src/shared/station-api";
import {
  BACKFILL_PENDING_PROPOSALS_V1,
  materializePendingProposal,
} from "../src/shared/pending-proposal-backfill";
import {
  IntentFactBasis,
  LogicalSequence,
  WORK_PROTOCOL,
  WorkCommand,
  WorkRecord,
  type ActorRef,
  type IntentFactBasis as IntentFactBasisValue,
  type WorkCommand as WorkCommandValue,
} from "../src/shared/work-protocol";
import type { TaskProposal } from "../src/shared/work-model";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import {
  makeContentServiceLive,
} from "../src/main/vellum/content/service";
import { makeInstallOpsLive } from "../src/main/vellum/install-ops/engine";
import { InstallOpsService } from "../src/main/vellum/install-ops/service";
import { makeSettingsLive, SettingsService } from "../src/main/vellum/settings/service";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import {
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  StationRepository,
  StationRepositoryLive,
  stationProjectionContentSha256,
} from "../src/main/vellum/station/repository";
import {
  compileStationPortfolioBody,
} from "../src/main/vellum/station/portfolio";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum/station/session-registry";
import {
  createTaskDependencyScopeCapability,
  workRecordContentSha256,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";
import { canonicalJson } from "../src/main/vellum/work/canonical-json";
import {
  allocateSequence,
  appendWorkRecord,
} from "../src/main/vellum/work/journal";
import { unjournaledWorkMutation } from "../src/main/vellum/work/mutation-seam";

const strictDecode = { onExcessProperty: "error" } as const;
const observedAt = "2026-08-26T19:00:00.000Z";
const roots: string[] = [];

const installation = (id: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(id);

const actor = (digit: string, nodeId: string): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`),
  canvasName: "factory",
  nodeId,
});

const proposal = (
  id: string,
  proposedBy: ActorRef,
): TaskProposal => ({
  id,
  state: "pending",
  brief: {
    messageId: `message-${id}`,
    role: "user",
    parts: [{ kind: "text", text: id }],
    taskId: id,
    contextId: "factory",
  },
  proposedBy,
  metadata: { title: id, details: `${id} details` },
  reason: `${id} reason`,
});

const taskCanvas = {
  nodes: [{
    id: "tasks",
    type: "text" as const,
    x: 0,
    y: 0,
    width: 260,
    height: 120,
    text: "Tasks",
    ether: {
      entity: { kind: "task", name: "Tasks" },
      host: "local",
    },
  }],
  edges: [],
};

const dependencyCanvas = Schema.decodeUnknownSync(CanvasDoc, strictDecode)({
  nodes: [
    {
      id: "region-same",
      type: "group" as const,
      x: 0,
      y: 0,
      width: 820,
      height: 360,
      label: "Same region",
    },
    {
      id: "region-cross",
      type: "group" as const,
      x: 900,
      y: 0,
      width: 320,
      height: 360,
      label: "Cross region",
    },
    {
      id: "tasks-a",
      type: "text" as const,
      x: 40,
      y: 60,
      width: 200,
      height: 100,
      text: "Tasks A",
      ether: { entity: { kind: "task", name: "Tasks A" }, host: "local" },
    },
    {
      id: "tasks-b",
      type: "text" as const,
      x: 300,
      y: 60,
      width: 200,
      height: 100,
      text: "Tasks B",
      ether: { entity: { kind: "task", name: "Tasks B" }, host: "local" },
    },
    {
      id: "tasks-cross",
      type: "text" as const,
      x: 950,
      y: 60,
      width: 200,
      height: 100,
      text: "Tasks cross",
      ether: {
        entity: { kind: "task", name: "Tasks cross" },
        host: "local",
      },
    },
    {
      id: "worker",
      type: "text" as const,
      x: 560,
      y: 60,
      width: 200,
      height: 100,
      text: "Worker",
      ether: {
        entity: { kind: "agent", name: "local:worker" },
        terminal: {
          bindingId: "binding-worker",
          launch: { kind: "harness", argv: ["claude"] },
          harness: "claude",
        },
        host: "local",
      },
    },
  ],
  edges: [
    {
      id: "worker-a",
      fromNode: "worker",
      toNode: "tasks-a",
      ether: { verb: "contributes" as const },
    },
    {
      id: "worker-b",
      fromNode: "worker",
      toNode: "tasks-b",
      ether: { verb: "contributes" as const },
    },
    {
      id: "worker-cross",
      fromNode: "worker",
      toNode: "tasks-cross",
      ether: { verb: "contributes" as const },
    },
  ],
});

type WorkRepositoryShape = Context.Service.Shape<typeof WorkRepository>;
type CanvasesShape = Context.Service.Shape<typeof CanvasesService>;

type RuntimeDecorators = {
  readonly repository?: (repository: WorkRepositoryShape) => WorkRepositoryShape;
  readonly canvases?: (canvases: CanvasesShape) => CanvasesShape;
};

const makeRuntime = (decorators: RuntimeDecorators = {}) => {
  const root = join(
    tmpdir(),
    `vellum-command-work-reconciliation-${randomUUID()}`,
  );
  roots.push(root);
  const stateLive = makeStateEngineLive(
    join(root, "state", "vellum-command.db"),
  );
  const repositoryLive = decorators.repository === undefined
    ? WorkRepositoryLive
    : Layer.provide(
        Layer.effect(
          WorkRepository,
          Effect.gen(function* () {
            return decorators.repository!(yield* WorkRepository);
          }),
        ),
        WorkRepositoryLive,
      );
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      repositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      makeSettingsLive({ ensureDefaultCommandCenter: false }),
      makeContentServiceLive({
        root: join(root, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      stateLive,
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesBase = Layer.provide(CanvasesLive, repositoriesLive);
  const canvasesLive = decorators.canvases === undefined
    ? canvasesBase
    : Layer.provide(
        Layer.effect(
          CanvasesService,
          Effect.gen(function* () {
            return decorators.canvases!(yield* CanvasesService);
          }),
        ),
        canvasesBase,
      );
  return ManagedRuntime.make(
    Layer.provideMerge(
      WorkLive,
      Layer.mergeAll(
        canvasesLive,
        repositoriesLive,
        StationLivePeerRegistryLive,
      ) as never,
    ) as never,
  );
};

const authorialBasis = async (
  runtime: ReturnType<typeof makeRuntime>,
): Promise<IntentFactBasisValue> => {
  const canvases = await runtime.runPromise(CanvasesService);
  const witness = await runtime.runPromise(canvases.activeIntentWitness());
  return Schema.decodeUnknownSync(IntentFactBasis, strictDecode)({
    kind: "authorial-intent",
    ...witness,
  });
};

const taskExists = async (
  runtime: ReturnType<typeof makeRuntime>,
  id: string,
): Promise<boolean> => {
  const repository = await runtime.runPromise(WorkRepository);
  const snapshot = await runtime.runPromise(
    repository.readSnapshot("factory", "tasks"),
  );
  return snapshot.tasks.items.some((task) => task.id === id);
};

const waitForTask = async (
  runtime: ReturnType<typeof makeRuntime>,
  id: string,
): Promise<void> => {
  await vi.waitFor(
    async () => {
      expect(await taskExists(runtime, id)).toBe(true);
    },
    { timeout: 5_000, interval: 10 },
  );
};

const resealCommand = (
  candidate: Omit<WorkCommandValue, "contentSha256">,
): WorkCommandValue => {
  const { originAt: _originAt, ...semantic } = candidate;
  return Schema.decodeUnknownSync(WorkCommand, strictDecode)({
    ...candidate,
    contentSha256: workRecordContentSha256(semantic),
  });
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("WorkService server-derived Task dependency capabilities", () => {
  it("admits local create, operator propose, and claim only within the current region", async () => {
    const runtime = makeRuntime();
    try {
      const settings = await runtime.runPromise(SettingsService);
      await runtime.runPromise(
        settings.setStationTopology({
          role: "command-center",
          hostId: "local",
          supervisedPreferred: true,
        }),
      );
      const canvases = await runtime.runPromise(CanvasesService);
      await runtime.runPromise(canvases.write("factory", dependencyCanvas));
      const read = await runtime.runPromise(canvases.read("factory"));
      const worker = read.actorRefs.find((ref) => ref.nodeId === "worker");
      if (worker === undefined) throw new Error("worker actor ref missing");

      const work = await runtime.runPromise(WorkService);
      const createdA = await runtime.runPromise(
        work.workTaskCreate(
          "factory",
          "tasks-a",
          "Task A",
          { details: "Task A details" },
        ),
      );
      expect(createdA.ok).toBe(true);
      if (!createdA.ok) throw new Error(createdA.message);

      const createdB = await runtime.runPromise(
        work.workTaskCreate(
          "factory",
          "tasks-b",
          "Task B",
          { details: "Task B details" },
          undefined,
          undefined,
          [createdA.data.id],
        ),
      );
      expect(createdB.ok).toBe(true);
      if (!createdB.ok) throw new Error(createdB.message);
      expect(createdB.data.dependsOn).toEqual([createdA.data.id]);

      const proposed = await runtime.runPromise(
        work.workTaskProposeOperator(
          "factory",
          "tasks-b",
          "Gated dependent",
          { details: "Gated dependent details" },
          undefined,
          undefined,
          [createdA.data.id],
        ),
      );
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) throw new Error(proposed.message);
      expect(proposed.data).toMatchObject({
        admission: "operator-gated",
        dependsOn: [createdA.data.id],
      });

      const crossRegion = await runtime.runPromise(
        work.workTaskCreate(
          "factory",
          "tasks-cross",
          "Cross-region dependent",
          { details: "Cross-region dependent details" },
          undefined,
          undefined,
          [createdA.data.id],
        ),
      );
      expect(crossRegion.ok).toBe(false);
      if (!crossRegion.ok) {
        expect(crossRegion.message).toContain("missing task");
      }

      const repository = await runtime.runPromise(WorkRepository);
      const basis = await authorialBasis(runtime);
      await runtime.runPromise(
        repository.claimLocalTask({
          sink: { canvasName: "factory", nodeId: "tasks-a" },
          basis,
          dependencyScope: createTaskDependencyScopeCapability({
            topology: dependencyCanvas,
            basis,
            authoringSink: { canvasName: "factory", nodeId: "tasks-a" },
          }),
          taskId: createdA.data.id,
          actor: worker,
        }),
      );
      await runtime.runPromise(
        repository.transitionTask({
          sink: { canvasName: "factory", nodeId: "tasks-a" },
          basis,
          taskId: createdA.data.id,
          state: "completed",
        }),
      );

      const claimedB = await runtime.runPromise(
        work.workTaskClaim(
          "factory",
          "tasks-b",
          createdB.data.id,
          worker,
        ),
      );
      expect(claimedB.ok).toBe(true);
      if (!claimedB.ok) throw new Error(claimedB.message);
      expect(claimedB.data).toMatchObject({
        id: createdB.data.id,
        state: "working",
        dependsOn: [createdA.data.id],
      });
    } finally {
      await runtime.dispose();
    }
  });
});

describe("WorkService pending-proposal reconciliation scheduling", () => {
  it("reconciles late local and replicated proposal arrivals after boot", async () => {
    const runtime = makeRuntime();
    try {
      const settings = await runtime.runPromise(SettingsService);
      await runtime.runPromise(
        settings.setStationTopology({
          role: "command-center",
          hostId: "local",
          supervisedPreferred: true,
        }),
      );
      const canvases = await runtime.runPromise(CanvasesService);
      await runtime.runPromise(canvases.write("factory", taskCanvas));

      // Acquiring WorkService starts one background dirty-bit worker. It does
      // not await the initial reconciliation walk.
      await runtime.runPromise(WorkService);
      const installOps = await runtime.runPromise(InstallOpsService);
      await vi.waitFor(
        async () => {
          expect(
            (await runtime.runPromise(
              installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
            ))?.status,
          ).toBe("complete");
        },
        { timeout: 5_000, interval: 10 },
      );

      const repository = await runtime.runPromise(WorkRepository);
      const basis = await authorialBasis(runtime);
      const localProposal = proposal(
        "late-local-proposal",
        actor("1", "local-raiser"),
      );
      await runtime.runPromise(
        repository.createProposal({
          sink: { canvasName: "factory", nodeId: "tasks" },
          basis,
          proposal: localProposal,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
      await waitForTask(runtime, localProposal.id);

      const state = await runtime.runPromise(StateEngine);
      const remote = installation("late-arrival-remote");
      await runtime.runPromise(
        state.transaction("test.register-remote", (writer) => {
          writer.run(
            `INSERT INTO station_known_installations(
               installation_id, registered_at
             ) VALUES (?, ?)`,
            [remote, observedAt],
          );
        }),
      );
      const station = await runtime.runPromise(StationRepository);
      const cc = await runtime.runPromise(station.installationId);
      const replicatedProposal = proposal(
        "late-replicated-proposal",
        actor("2", "remote-raiser"),
      );
      const command = resealCommand({
        protocol: "vellum/work/v2",
        id: {
          route: { eventHome: remote, entityHome: cc },
          seq: Schema.decodeUnknownSync(LogicalSequence)("1"),
        },
        recordType: "command",
        item: {
          kind: "proposal",
          itemId: replicatedProposal.id,
          sink: { canvasName: "factory", nodeId: "tasks" },
        },
        operation: "proposal.create",
        originAt: observedAt,
        predecessor: null,
        body: {
          operation: "proposal.create",
          proposal: replicatedProposal,
        },
      });
      const admitted = () => ({ _tag: "admitted" as const });
      await runtime.runPromise(
        repository.acceptRecords({
          senderInstallationId: remote,
          records: [command],
          peerAcknowledgements: [],
          receivedAt: observedAt,
          authorizeCommand: admitted,
          authorizeFact: admitted,
          admitResponse: admitted,
        }),
      );
      await waitForTask(runtime, replicatedProposal.id);
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps WorkService available when a late proposal cannot be reconciled", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    try {
      const settings = await runtime.runPromise(SettingsService);
      await runtime.runPromise(
        settings.setStationTopology({
          role: "command-center",
          hostId: "local",
          supervisedPreferred: true,
        }),
      );
      const canvases = await runtime.runPromise(CanvasesService);
      await runtime.runPromise(canvases.write("factory", taskCanvas));
      const work = await runtime.runPromise(WorkService);
      const installOps = await runtime.runPromise(InstallOpsService);
      await vi.waitFor(
        async () => {
          expect(
            (await runtime.runPromise(
              installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
            ))?.status,
          ).toBe("complete");
        },
        { timeout: 5_000, interval: 10 },
      );

      const retiredTaskCanvas = Schema.decodeUnknownSync(
        CanvasDoc,
        strictDecode,
      )({
        ...taskCanvas,
        nodes: taskCanvas.nodes.map((node) => ({
          ...node,
          ether: {
            entity: { kind: "note", name: "Retired Task sink" },
            host: "local",
          },
        })),
      });
      await runtime.runPromise(
        canvases.write("factory", retiredTaskCanvas),
      );
      const repository = await runtime.runPromise(WorkRepository);
      const late = proposal(
        "late-invalid-proposal",
        actor("4", "late-invalid-raiser"),
      );
      await runtime.runPromise(
        repository.createProposal({
          sink: { canvasName: "factory", nodeId: "tasks" },
          basis: await authorialBasis(runtime),
          proposal: late,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );

      await vi.waitFor(
        async () => {
          expect(
            (await runtime.runPromise(
              installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
            ))?.status,
          ).toBe("pending");
        },
        { timeout: 5_000, interval: 10 },
      );
      expect(await runtime.runPromise(WorkService)).toBe(work);
      const snapshot = await runtime.runPromise(
        repository.readSnapshot("factory", "tasks"),
      );
      expect((snapshot.tasks.proposals ?? []).map((item) => item.id)).toContain(
        late.id,
      );
      expect(snapshot.tasks.items.map((item) => item.id)).not.toContain(late.id);
      await vi.waitFor(() => {
        expect(
          errorLog.mock.calls.some((call) =>
            String(call[0]).includes("parked at a fixed point")
          ),
        ).toBe(true);
      });
      const parkedLogCount = errorLog.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(errorLog.mock.calls.length).toBe(parkedLogCount);

      // This authorial topology repair is the only wake. No unrelated Work row
      // is written between the parked fixed point and materialization.
      await runtime.runPromise(canvases.write("factory", taskCanvas));
      await waitForTask(runtime, late.id);
      await vi.waitFor(
        async () => {
          expect(
            (await runtime.runPromise(
              installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
            ))?.status,
          ).toBe("complete");
        },
        { timeout: 5_000, interval: 10 },
      );
    } finally {
      errorLog.mockRestore();
      await runtime.dispose();
    }
  });

  it("does not rescan for a large burst of unrelated Work history", async () => {
    let witnessReads = 0;
    const runtime = makeRuntime({
      repository: (repository) => ({
        ...repository,
        legacyProposalMaterializationWitnessPage: (input) => {
          witnessReads += 1;
          return repository.legacyProposalMaterializationWitnessPage(input);
        },
      }),
    });
    try {
      const settings = await runtime.runPromise(SettingsService);
      await runtime.runPromise(
        settings.setStationTopology({
          role: "command-center",
          hostId: "local",
          supervisedPreferred: true,
        }),
      );
      const canvases = await runtime.runPromise(CanvasesService);
      await runtime.runPromise(canvases.write("factory", taskCanvas));
      const repository = await runtime.runPromise(WorkRepository);
      const basis = await authorialBasis(runtime);
      const source = proposal(
        "unrelated-history-task",
        actor("9", "unrelated-history-raiser"),
      );
      const task = materializePendingProposal({ proposal: source }).task;
      const dependencyScope = createTaskDependencyScopeCapability({
        topology: Schema.decodeUnknownSync(CanvasDoc, strictDecode)(taskCanvas),
        basis,
        authoringSink: { canvasName: "factory", nodeId: "tasks" },
      });
      await runtime.runPromise(
        repository.createTask({
          sink: { canvasName: "factory", nodeId: "tasks" },
          basis,
          task,
          dependencyScope,
        }),
      );
      await runtime.runPromise(WorkService);
      const installOps = await runtime.runPromise(InstallOpsService);
      await vi.waitFor(
        async () => {
          expect(
            (await runtime.runPromise(
              installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
            ))?.status,
          ).toBe("complete");
        },
        { timeout: 5_000, interval: 10 },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const beforeBurst = witnessReads;

      for (let index = 0; index < 96; index += 1) {
        await runtime.runPromise(
          repository.describeTask({
            sink: { canvasName: "factory", nodeId: "tasks" },
            basis,
            dependencyScope,
            taskId: task.id,
            message: {
              messageId: `unrelated-description-${index}`,
              role: "user",
              parts: [{ kind: "text", text: `Unrelated ${index}` }],
              taskId: task.id,
              contextId: "factory",
            },
            originAt: observedAt,
            receivedAt: observedAt,
          }),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(witnessReads).toBe(beforeBurst);
      expect(repository.legacyProposalMaterializationEpoch()).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("wakes when an unconfigured installation becomes Command Center", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    try {
      const canvases = await runtime.runPromise(CanvasesService);
      await runtime.runPromise(canvases.write("factory", taskCanvas));
      await runtime.runPromise(WorkService);
      const station = await runtime.runPromise(StationRepository);
      const cc = await runtime.runPromise(station.installationId);
      const state = await runtime.runPromise(StateEngine);
      const source = proposal(
        "waiting-for-command-center-role",
        actor("8", "pre-role-raiser"),
      );
      const basis = await authorialBasis(runtime);
      await runtime.runPromise(
        state.transaction("test.seed-pre-role-proposal", (writer) =>
          unjournaledWorkMutation("test.fixture-seed", () => {
            const semantic = {
              protocol: WORK_PROTOCOL,
              id: {
                route: { eventHome: cc, entityHome: cc },
                seq: allocateSequence(writer, cc, cc),
              },
              recordType: "fact" as const,
              item: {
                kind: "proposal" as const,
                itemId: source.id,
                sink: { canvasName: "factory", nodeId: "tasks" },
              },
              operation: "proposal.create" as const,
              predecessor: null,
              basis,
              body: { operation: "proposal.create" as const, proposal: source },
            };
            const record = Schema.decodeUnknownSync(WorkRecord, strictDecode)({
              ...semantic,
              contentSha256: workRecordContentSha256(semantic),
              originAt: observedAt,
            });
            if (
              record.recordType !== "fact" ||
              record.body.operation !== "proposal.create"
            ) {
              throw new Error("invalid pre-role proposal fixture");
            }
            appendWorkRecord(writer, record, observedAt);
            writer.run(
              `INSERT INTO work_task_proposals(
                 canvas_name, node_id, proposal_id, entity_home,
                 fact_event_home, fact_entity_home, fact_seq, state,
                 brief_json, proposer_seat_id, proposer_canvas_name,
                 proposer_node_id, approved_task_id, metadata_json, reason,
                 created_at, updated_at, origin_at, received_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
              [
                "factory",
                "tasks",
                source.id,
                cc,
                cc,
                cc,
                record.id.seq,
                source.state,
                canonicalJson(source.brief),
                source.proposedBy.seatId,
                source.proposedBy.canvasName,
                source.proposedBy.nodeId,
                source.metadata === undefined
                  ? null
                  : canonicalJson(source.metadata),
                source.reason ?? null,
                observedAt,
                observedAt,
                observedAt,
                observedAt,
              ],
            );
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(await taskExists(runtime, source.id)).toBe(false);

      const settings = await runtime.runPromise(SettingsService);
      await runtime.runPromise(
        settings.setStationTopology({
          role: "command-center",
          hostId: "local",
          supervisedPreferred: true,
        }),
      );
      // The settings transition is the only signal after configuration.
      await waitForTask(runtime, source.id);
    } finally {
      errorLog.mockRestore();
      await runtime.dispose();
    }
  });

  it("survives a defective iteration and recovers on a later Work signal", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    try {
      const settings = await runtime.runPromise(SettingsService);
      await runtime.runPromise(
        settings.setStationTopology({
          role: "command-center",
          hostId: "local",
          supervisedPreferred: true,
        }),
      );
      const canvases = await runtime.runPromise(CanvasesService);
      await runtime.runPromise(canvases.write("factory", taskCanvas));
      const repository = await runtime.runPromise(WorkRepository);
      const mutable = repository as unknown as {
        legacyProposalMaterializationWitnessPage:
          typeof repository.legacyProposalMaterializationWitnessPage;
      };
      const strongPage = repository.legacyProposalMaterializationWitnessPage;
      let defectOnce = true;
      mutable.legacyProposalMaterializationWitnessPage = (input) => {
        if (defectOnce) {
          defectOnce = false;
          return Effect.die(new Error("simulated strong-index defect"));
        }
        return strongPage(input);
      };

      await runtime.runPromise(WorkService);
      await vi.waitFor(() => {
        expect(
          errorLog.mock.calls.some((call) =>
            String(call[1]).includes("simulated strong-index defect")
          ),
        ).toBe(true);
      });

      const late = proposal("after-defect", actor("7", "after-defect-raiser"));
      await runtime.runPromise(
        repository.createProposal({
          sink: { canvasName: "factory", nodeId: "tasks" },
          basis: await authorialBasis(runtime),
          proposal: late,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
      await waitForTask(runtime, late.id);
    } finally {
      errorLog.mockRestore();
      await runtime.dispose();
    }
  });

  it("unsubscribes both invalidation sources and ignores callbacks after shutdown", async () => {
    let repositoryCallback:
      | Parameters<WorkRepositoryShape["subscribeLegacyProposalMaterializationChanges"]>[0]
      | undefined;
    let canvasCallback:
      | Parameters<CanvasesShape["subscribeChanges"]>[0]
      | undefined;
    let repositoryUnsubscribes = 0;
    let canvasUnsubscribes = 0;
    let witnessReads = 0;
    const runtime = makeRuntime({
      repository: (repository) => ({
        ...repository,
        legacyProposalMaterializationWitnessPage: (input) => {
          witnessReads += 1;
          return repository.legacyProposalMaterializationWitnessPage(input);
        },
        subscribeLegacyProposalMaterializationChanges: (listener) => {
          repositoryCallback = listener;
          const unsubscribe =
            repository.subscribeLegacyProposalMaterializationChanges(listener);
          return () => {
            repositoryUnsubscribes += 1;
            unsubscribe();
          };
        },
      }),
      canvases: (canvases) => ({
        ...canvases,
        subscribeChanges: (listener) => {
          canvasCallback = listener;
          const unsubscribe = canvases.subscribeChanges(listener);
          return () => {
            canvasUnsubscribes += 1;
            unsubscribe();
          };
        },
      }),
    });
    let disposed = false;
    try {
      const settings = await runtime.runPromise(SettingsService);
      await runtime.runPromise(
        settings.setStationTopology({
          role: "command-center",
          hostId: "local",
          supervisedPreferred: true,
        }),
      );
      const canvases = await runtime.runPromise(CanvasesService);
      await runtime.runPromise(canvases.write("factory", taskCanvas));
      await runtime.runPromise(WorkService);
      const installOps = await runtime.runPromise(InstallOpsService);
      await vi.waitFor(
        async () => {
          expect(
            (await runtime.runPromise(
              installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
            ))?.status,
          ).toBe("complete");
        },
        { timeout: 5_000, interval: 10 },
      );
      const beforeProjectionEcho = witnessReads;
      canvasCallback?.("factory", undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(witnessReads).toBe(beforeProjectionEcho);

      await runtime.dispose();
      disposed = true;
      expect(repositoryUnsubscribes).toBe(1);
      expect(canvasUnsubscribes).toBe(1);
      const afterDispose = witnessReads;
      repositoryCallback?.();
      canvasCallback?.("factory", {
        previous: undefined,
        next: undefined,
      });
      canvasCallback?.("factory", undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(witnessReads).toBe(afterDispose);
    } finally {
      if (!disposed) await runtime.dispose();
    }
  });

  it("continues a full sweep past 32 invalid keys and then parks", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    try {
      const settings = await runtime.runPromise(SettingsService);
      await runtime.runPromise(
        settings.setStationTopology({
          role: "command-center",
          hostId: "local",
          supervisedPreferred: true,
        }),
      );
      const canvases = await runtime.runPromise(CanvasesService);
      await runtime.runPromise(canvases.write("factory", taskCanvas));
      const repository = await runtime.runPromise(WorkRepository);
      const station = await runtime.runPromise(StationRepository);
      const home = await runtime.runPromise(station.installationId);
      const basis = await authorialBasis(runtime);
      const topology = Schema.decodeUnknownSync(CanvasDoc, strictDecode)(taskCanvas);
      const dependencyScope = createTaskDependencyScopeCapability({
        topology,
        basis,
        authoringSink: { canvasName: "factory", nodeId: "tasks" },
      });

      for (let index = 0; index < 32; index += 1) {
        const id = `a-invalid-${String(index).padStart(2, "0")}`;
        const source = proposal(id, actor("5", `raiser-${index}`));
        await runtime.runPromise(
          repository.createTask({
            sink: { canvasName: "factory", nodeId: "tasks" },
            basis,
            task: materializePendingProposal({ proposal: source }).task,
            dependencyScope,
          }),
        );
        await runtime.runPromise(
          repository.createProposal({
            sink: { canvasName: "factory", nodeId: "tasks" },
            basis,
            proposal: source,
            originAt: observedAt,
            receivedAt: observedAt,
          }),
        );
      }
      const valid = proposal("z-valid-after-prefix", actor("6", "valid-raiser"));
      await runtime.runPromise(
        repository.createProposal({
          sink: { canvasName: "factory", nodeId: "tasks" },
          basis,
          proposal: valid,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );

      await runtime.runPromise(WorkService);
      await waitForTask(runtime, valid.id);
      const installOps = await runtime.runPromise(InstallOpsService);
      await vi.waitFor(
        async () => {
          expect(
            (await runtime.runPromise(
              installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
            ))?.status,
          ).toBe("pending");
          expect(
            errorLog.mock.calls.some((call) =>
              String(call[0]).includes("parked at a fixed point")
            ),
          ).toBe(true);
        },
        { timeout: 10_000, interval: 10 },
      );
      const parked = errorLog.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(errorLog.mock.calls.length).toBe(parked);
      expect(home).toBeTruthy();
    } finally {
      errorLog.mockRestore();
      await runtime.dispose();
    }
  });

  it("does not run legacy reconciliation on a Remote", async () => {
    const runtime = makeRuntime();
    try {
      const station = await runtime.runPromise(StationRepository);
      const local = await runtime.runPromise(station.installationId);
      const cc = installation("remote-refusal-command-center");
      await runtime.runPromise(
        station.pair(
          PairRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "pair",
            commandCenterInstallationId: cc,
            stationInstallationId: local,
            stationLabel: "Remote refusal",
            appVersion: "test",
          }),
        ),
      );
      const remoteHostId = Schema.decodeUnknownSync(StationHostId)("remote");
      await runtime.runPromise(
        station.configureRemote(
          ConfigureRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "configure",
            installationId: local,
            configuration: {
              role: "remote",
              hostId: remoteHostId,
              agentHostId: remoteHostId,
              commandCenterInstallationId: cc,
              supervisedPreferred: true,
            },
            host: {
              id: remoteHostId,
              label: "Remote refusal",
              kind: "remote",
              capabilities: ["terminal"],
            },
          }),
        ),
      );

      const remoteDoc = Schema.decodeUnknownSync(CanvasDoc, strictDecode)({
        ...taskCanvas,
        nodes: taskCanvas.nodes.map((node) => ({
          ...node,
          ether: { ...node.ether, host: remoteHostId },
        })),
      });
      const projectionBody = compileStationPortfolioBody(
        new Map([["factory", remoteDoc]]),
        new Map([[remoteHostId, local]]),
      );
      await runtime.runPromise(
        station.installProjection(
          ProjectRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "project",
            stationInstallationId: local,
            projection: {
              scope: "full",
              generation: Schema.decodeUnknownSync(StationLogicalSequence)("1"),
              sourceCanvasGeneration:
                Schema.decodeUnknownSync(StationLogicalSequence)("1"),
              sourceIntentSha256:
                stationProjectionContentSha256("remote refusal source"),
              body: projectionBody,
              contentSha256: stationProjectionContentSha256(projectionBody),
              createdAt: observedAt,
            },
          }),
        ),
      );

      await runtime.runPromise(WorkService);
      const canvases = await runtime.runPromise(CanvasesService);
      const witness = await runtime.runPromise(canvases.activeIntentWitness());
      const projectedBasis = Schema.decodeUnknownSync(
        IntentFactBasis,
        strictDecode,
      )({ kind: "projected-intent", ...witness });
      const repository = await runtime.runPromise(WorkRepository);
      const late = proposal(
        "remote-late-proposal",
        actor("3", "remote-raiser"),
      );
      await runtime.runPromise(
        repository.createProposal({
          sink: { canvasName: "factory", nodeId: "tasks" },
          basis: projectedBasis,
          proposal: late,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 75));
      const snapshot = await runtime.runPromise(
        repository.readSnapshot("factory", "tasks"),
      );
      expect((snapshot.tasks.proposals ?? []).map((item) => item.id)).toContain(
        late.id,
      );
      expect(snapshot.tasks.items.map((item) => item.id)).not.toContain(late.id);
      const installOps = await runtime.runPromise(InstallOpsService);
      expect(
        await runtime.runPromise(
          installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
        ),
      ).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});
