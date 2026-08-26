import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKFILL_PENDING_PROPOSALS_V1,
  materializePendingProposal,
  PENDING_PROPOSAL_BACKFILL_ADMISSION,
  planProposalBackfill,
  planProposalBackfillFrontier,
  proposalBackfillDependencyKey,
  proposalBackfillTaskKey,
  recoverClaimsFromProposalRecordJson,
} from "../src/shared/pending-proposal-backfill";
import { PIPELINE_ADMITTED_METADATA_KEY } from "../src/shared/claims";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { CanvasDoc } from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import {
  IntentFactBasis,
  WORK_PROTOCOL,
  WorkRecord,
  type WorkFact as WorkFactValue,
} from "../src/shared/work-protocol";
import { ActorRef } from "../src/shared/work-reference";
import {
  runPendingProposalBackfill as runPendingProposalBackfillRaw,
  type PendingProposalBackfillReport,
  type PersistUnadmittedTask,
} from "../src/main/vellum/work/pending-proposal-backfill";
import {
  createTaskDependencyScopeCapability,
  WorkRepository,
  WorkRepositoryLive,
  workRecordContentSha256,
} from "../src/main/vellum/work/repository";
import { canonicalJson } from "../src/main/vellum/work/canonical-json";
import { unjournaledWorkMutation } from "../src/main/vellum/work/mutation-seam";
import {
  allocateSequence,
  appendWorkRecord,
} from "../src/main/vellum/work/journal";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import {
  InstallOpsService,
  makeInstallOpsLive,
} from "../src/main/vellum/install-ops/engine";
import { actorRefFixture } from "./helpers/actor-ref-fixtures";

const proposedBy = actorRefFixture("agent-1");

const backfillTopology: CanvasDoc = {
  nodes: [
    {
      id: "tasks-1",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: "Tasks",
      ether: { entity: { kind: "task" } },
    },
  ],
  edges: [],
};
const backfillTopologyBody = JSON.stringify(backfillTopology);
const backfillTopologySha256 = createHash("sha256")
  .update(backfillTopologyBody, "utf8")
  .digest("hex");

const pendingSnapshot = {
  id: "prop-1",
  state: "pending" as const,
  brief: {
    messageId: "m-prop-1",
    role: "user" as const,
    parts: [{ kind: "text" as const, text: "Do the thing" }],
    taskId: "prop-1",
    contextId: "factory",
  },
  proposedBy,
  metadata: { details: "A real description.", extra: "keep" },
  reason: "needed",
  dependsOn: ["task-0"],
  finishCriteria: { description: "done" },
};

describe("planProposalBackfill", () => {
  const keys = new Set<string>();

  it("materializes pending when no task row exists", () => {
    expect(
      planProposalBackfill({
        state: "pending",
        proposalId: "prop-1",
        canvasName: "factory",
        nodeId: "tasks",
        existingTaskKeys: keys,
      }),
    ).toEqual({ action: "materialize" });
  });

  it("skips pending once the same-id task exists", () => {
    expect(
      planProposalBackfill({
        state: "pending",
        proposalId: "prop-1",
        canvasName: "factory",
        nodeId: "tasks",
        existingTaskKeys: new Set([
          proposalBackfillTaskKey("factory", "tasks", "prop-1"),
        ]),
      }),
    ).toEqual({ action: "skip", reason: "already-materialized" });
  });

  it("never mints a task for historical rejected proposals", () => {
    expect(
      planProposalBackfill({
        state: "rejected",
        proposalId: "prop-1",
        canvasName: "factory",
        nodeId: "tasks",
        existingTaskKeys: keys,
      }),
    ).toEqual({ action: "skip", reason: "rejected-historical" });
  });

  it("leaves approved proposals on their existing (possibly other-id) task", () => {
    expect(
      planProposalBackfill({
        state: "approved",
        proposalId: "prop-1",
        canvasName: "factory",
        nodeId: "tasks",
        approvedTaskId: "task-minted",
        existingTaskKeys: keys,
      }),
    ).toEqual({ action: "skip", reason: "approved-has-task" });
  });

  it("uses structural keys even when identity strings contain separators", () => {
    expect(proposalBackfillTaskKey("a\0b", "c", "d")).not.toBe(
      proposalBackfillTaskKey("a", "b", "c\0d"),
    );
  });

  it("plans only the frontier whose explicit dependencies are durable", () => {
    expect(
      planProposalBackfillFrontier({
        candidates: [
          { key: "root", canvasName: "factory" },
          { key: "ready", canvasName: "factory", dependsOn: ["task-0"] },
          { key: "waiting", canvasName: "factory", dependsOn: ["root"] },
        ],
        existingDependencyKeys: new Set([
          proposalBackfillDependencyKey("factory", "task-0"),
        ]),
      }),
    ).toEqual({ ready: ["root", "ready"], waiting: ["waiting"] });
  });
});

describe("materializePendingProposal", () => {
  it("keeps the proposal id, strips promotion metadata, stamps gated overlay", () => {
    const out = materializePendingProposal({
      proposal: {
        ...pendingSnapshot,
        metadata: {
          details: "A real description.",
          extra: "keep",
          "vellum.pipeline": { epoch: 3 },
          [PIPELINE_ADMITTED_METADATA_KEY]: 0,
        },
        claims: [
          { id: "c1", text: "Checked", severity: "hard", station: "qa" },
        ],
      },
    });
    expect(out.admission).toBe(PENDING_PROPOSAL_BACKFILL_ADMISSION);
    expect(out.raisedBy).toEqual(proposedBy);
    expect(out.task.id).toBe("prop-1");
    expect(out.task.state).toBe("submitted");
    expect(out.task.claimedBy).toBeUndefined();
    expect(out.task.holdUntil).toBeUndefined();
    expect(out.task.metadata).toEqual({
      details: "A real description.",
      extra: "keep",
    });
    expect(out.task.metadata?.[PIPELINE_ADMITTED_METADATA_KEY]).toBeUndefined();
    expect(out.task.reason).toBe("needed");
    expect(out.task.dependsOn).toEqual(["task-0"]);
    expect(out.task.finishCriteria).toEqual({ description: "done" });
    expect(out.task.claims).toEqual([
      { id: "c1", text: "Checked", severity: "hard", station: "qa" },
    ]);
    expect(out.task.history[0]?.taskId).toBe("prop-1");
  });

  it("preserves an explicitly authored empty dependency array", () => {
    const out = materializePendingProposal({
      proposal: { ...pendingSnapshot, dependsOn: [] },
    });
    expect(out.task.dependsOn).toEqual([]);
  });

  it("recovers claims from record_json when the projection dropped them", () => {
    const out = materializePendingProposal({
      proposal: pendingSnapshot,
      claimsFromRecord: [
        { id: "c2", text: "From log", severity: "soft", station: "qa" },
      ],
    });
    expect(out.task.claims).toEqual([
      { id: "c2", text: "From log", severity: "soft", station: "qa" },
    ]);
  });
});

describe("recoverClaimsFromProposalRecordJson", () => {
  const claims = [
    { id: "c3", text: "Logged", severity: "soft", station: "qa" },
  ];

  it("finds claims on a proposal.create fact body", () => {
    expect(
      recoverClaimsFromProposalRecordJson({
        recordType: "fact",
        operation: "proposal.create",
        body: {
          operation: "proposal.create",
          proposal: { id: "prop-1", claims },
        },
      }),
    ).toEqual(claims);
  });

  it("returns undefined on truncated or unparseable history", () => {
    expect(recoverClaimsFromProposalRecordJson("{")).toBeUndefined();
    expect(recoverClaimsFromProposalRecordJson({ brief: { parts: [] } })).toBeUndefined();
  });
});

const homes: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<any, unknown>> = [];
let currentWitnessReader:
  | Context.Service.Shape<typeof WorkRepository>["legacyProposalMaterializationWitnessPage"]
  | undefined;
let currentEpochReader:
  | Context.Service.Shape<typeof WorkRepository>["legacyProposalMaterializationEpoch"]
  | undefined;

type RawBackfillInput = Parameters<typeof runPendingProposalBackfillRaw>[0];
const runPendingProposalBackfill = (
  input: Omit<RawBackfillInput, "readWitnessPage" | "readEpoch"> & {
    readonly readWitnessPage?: RawBackfillInput["readWitnessPage"];
    readonly readEpoch?: RawBackfillInput["readEpoch"];
  },
) => {
  const readWitnessPage = input.readWitnessPage ?? currentWitnessReader;
  const readEpoch = input.readEpoch ?? currentEpochReader;
  if (readWitnessPage === undefined || readEpoch === undefined) {
    throw new Error("test harness has no strong legacy witness reader");
  }
  return runPendingProposalBackfillRaw({
    ...input,
    readWitnessPage,
    readEpoch,
  });
};

const continueBackfillToBoundary = async (
  input: Omit<RawBackfillInput, "readWitnessPage" | "readEpoch" | "cursor"> & {
    readonly readWitnessPage?: RawBackfillInput["readWitnessPage"];
    readonly readEpoch?: RawBackfillInput["readEpoch"];
  },
  initial: PendingProposalBackfillReport,
) => {
  let report = initial;
  for (let pass = 0; pass < 128; pass += 1) {
    if (
      report.status !== "pending" ||
      report.reason !== "budget-exhausted"
    ) {
      return report;
    }
    report = await Effect.runPromise(
      runPendingProposalBackfill({ ...input, cursor: report.cursor }),
    );
  }
  throw new Error("backfill test exceeded its continuation budget");
};

const runBackfillToBoundary = async (
  input: Omit<RawBackfillInput, "readWitnessPage" | "readEpoch" | "cursor"> & {
    readonly readWitnessPage?: RawBackfillInput["readWitnessPage"];
    readonly readEpoch?: RawBackfillInput["readEpoch"];
  },
) =>
  continueBackfillToBoundary(
    input,
    await Effect.runPromise(runPendingProposalBackfill(input)),
  );

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (homes.length > 0) {
    await rm(homes.pop()!, { recursive: true, force: true });
  }
});

const openHarness = async () => {
  const home = join(tmpdir(), `vellum-pending-proposal-backfill-${randomUUID()}`);
  homes.push(home);
  const stateDir = join(home, ".vellum-command", "state");
  await mkdir(stateDir, { recursive: true });
  const observedAt = "2026-08-25T00:00:00.000Z";
  const cc = Schema.decodeUnknownSync(InstallationId)("cc-pending-backfill");
  const intentSha = "d".repeat(64);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.provideMerge(
        WorkRepositoryLive,
        makeStateEngineLive(join(stateDir, "vellum-command.db")),
      ),
      makeInstallOpsLive(join(stateDir, "install-ops.db")),
    ),
  );
  runtimes.push(runtime);
  const state = await runtime.runPromise(StateEngine);
  const repository = await runtime.runPromise(WorkRepository);
  currentWitnessReader = repository.legacyProposalMaterializationWitnessPage;
  currentEpochReader = repository.legacyProposalMaterializationEpoch;
  const installOps = await runtime.runPromise(InstallOpsService);
  await runtime.runPromise(
    state.transaction("test.seed", (writer) => {
      writer.run(
        `INSERT INTO station_known_installations(installation_id, registered_at)
         VALUES (?, ?)`,
        [cc, observedAt],
      );
      writer.run(
        `INSERT INTO station_installation(singleton, installation_id, created_at)
         VALUES (1, ?, ?)`,
        [cc, observedAt],
      );
      writer.run(
        `INSERT INTO station_configuration(
           singleton, role, host_id, agent_host_id,
           command_center_installation_id, supervised_preferred, configured_at
         ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, ?)`,
        [observedAt],
      );
      writer.run(
        `INSERT INTO canvas_generations(
           generation, created_at, cause, intent_sha256, document_count
         ) VALUES ('1', ?, 'test intent', ?, 1)`,
        [observedAt, intentSha],
      );
      writer.run(
        `INSERT INTO canvas_generation_documents(
           generation, name, body, sha256, modified_at
         ) VALUES ('1', 'factory', ?, ?, ?)`,
        [backfillTopologyBody, backfillTopologySha256, observedAt],
      );
      writer.run(`INSERT INTO canvas_head(singleton, generation) VALUES (1, '1')`);
    }),
  );
  const basis = Schema.decodeUnknownSync(IntentFactBasis, {
    onExcessProperty: "error",
  })({
    kind: "authorial-intent",
    generation: "1",
    contentSha256: intentSha,
  });
  const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`);
  const actor = Schema.decodeUnknownSync(ActorRef)({
    seatId,
    canvasName: "factory",
    nodeId: "agent-1",
  });
  return {
    runtime,
    state,
    repository,
    installOps,
    basis,
    actor,
    observedAt,
    installationId: cc,
  };
};

const sink = { canvasName: "factory", nodeId: "tasks-1" } as const;

describe("runPendingProposalBackfill", () => {
  it("does not complete when persist mints no work_tasks row", async () => {
    const { state, repository, installOps, basis, actor, observedAt } =
      await openHarness();
    await runtimeCreateProposal(repository, basis, actor, observedAt, {
      id: "prop-live",
      details: "Live pending work.",
    });

    const persist: PersistUnadmittedTask = (input) =>
      Effect.succeed({
        status: "invalid" as const,
        proposalId: input.proposalId,
        diagnostic: {
          code: "dependency-invalid" as const,
          message: "test persist intentionally minted no Task",
        },
        message: "test persist intentionally minted no Task",
      });
    const report = await Effect.runPromise(
      runPendingProposalBackfill({ state, installOps, persist }),
    );
    expect(report).toMatchObject({
      status: "pending",
      materialized: 0,
      skipped: 0,
      failed: 1,
      remaining: 1,
    });

    const marker = await Effect.runPromise(
      installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
    );
    expect(marker?.status).toBe("pending");
  });

  it("materializes pending as a same-id task, skips rejected, leaves proposal events byte-identical", async () => {
    const { runtime, state, repository, installOps, basis, actor, observedAt } =
      await openHarness();
    await runtimeCreateProposal(repository, basis, actor, observedAt, {
      id: "prop-live",
      details: "Live pending work.",
      claims: [
        { id: "c-log", text: "From create fact", severity: "soft", station: "qa" },
      ],
    });
    await runtimeCreateProposal(repository, basis, actor, observedAt, {
      id: "prop-rejected",
      details: "Will be refused as a proposal.",
    });
    await runtime.runPromise(
      repository.rejectProposal({
        sink,
        basis,
        proposalId: "prop-rejected",
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const eventsBefore = await fingerprintProposalEvents(state);

    let captured: Parameters<PersistUnadmittedTask>[0] | undefined;
    const persist: PersistUnadmittedTask = (input) => {
      captured = input;
      const inputSink = {
        canvasName: input.canvasName,
        nodeId: input.nodeId,
      };
      return repository.persistUnadmittedTask({
        sink: inputSink,
        proposalId: input.proposalId,
        home: Schema.decodeUnknownSync(InstallationId)("cc-pending-backfill"),
        basis,
        dependencyScope: createTaskDependencyScopeCapability({
          topology: backfillTopology,
          basis,
          authoringSink: inputSink,
        }),
      });
    };

    const report = await runBackfillToBoundary({ state, installOps, persist });
    expect(report.status).toBe("complete");
    expect(report.materialized).toBe(1);
    expect(captured?.proposalId).toBe("prop-live");
    const reconstructed = await runtime.runPromise(
      repository.readSnapshot(sink.canvasName, sink.nodeId),
    );
    expect(reconstructed.tasks.items[0]?.admission).toBe("operator-gated");
    expect(reconstructed.tasks.items[0]?.raisedBy).toEqual(actor);
    expect(reconstructed.tasks.items[0]?.claims).toEqual([
      { id: "c-log", text: "From create fact", severity: "soft", station: "qa" },
    ]);

    const snapshot = await Effect.runPromise(
      state.read("assert.tasks", (reader) =>
        reader.get<{ readonly task_id: string; readonly state: string }>(
          `
            SELECT task_id, state FROM work_tasks
            WHERE canvas_name = ? AND node_id = ? AND task_id = ?
          `,
          [sink.canvasName, sink.nodeId, "prop-live"],
        ),
      ),
    );
    expect(snapshot).toEqual({ task_id: "prop-live", state: "submitted" });

    const rejectedTask = await Effect.runPromise(
      state.read("assert.no-rejected-task", (reader) =>
        reader.get(
          `
            SELECT task_id FROM work_tasks
            WHERE canvas_name = ? AND node_id = ? AND task_id = ?
          `,
          [sink.canvasName, sink.nodeId, "prop-rejected"],
        ),
      ),
    );
    expect(rejectedTask).toBeUndefined();

    expect(await fingerprintProposalEvents(state)).toEqual(eventsBefore);

    const again = await Effect.runPromise(
      runPendingProposalBackfill({ state, installOps, persist }),
    );
    expect(again.status).toBe("already-complete");
    expect(again.materialized).toBe(0);
  });

  it("keeps exact marker counts across approval and rejection", async () => {
    const harness = await openHarness();
    const { dependsOn: _ignoredDependencies, ...proposalBase } =
      pendingSnapshot;
    const rejected = {
      ...proposalBase,
      id: "materialized-then-rejected",
      brief: {
        ...pendingSnapshot.brief,
        messageId: "materialized-then-rejected-brief",
        taskId: "materialized-then-rejected",
      },
      proposedBy: harness.actor,
    };
    const approved = {
      ...proposalBase,
      id: "materialized-then-approved",
      brief: {
        ...pendingSnapshot.brief,
        messageId: "materialized-then-approved-brief",
        taskId: "materialized-then-approved",
      },
      proposedBy: harness.actor,
    };
    for (const source of [rejected, approved]) {
      await harness.runtime.runPromise(
        harness.repository.createProposal({
          sink,
          basis: harness.basis,
          proposal: source,
          originAt: harness.observedAt,
          receivedAt: harness.observedAt,
        }),
      );
    }

    const report = await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist: repositoryPersist(harness),
    });
    expect(report).toMatchObject({
      status: "complete",
      materialized: 2,
      skipped: 0,
      failed: 0,
      remaining: 0,
    });

    await harness.runtime.runPromise(
      harness.repository.rejectProposal({
        sink,
        basis: harness.basis,
        proposalId: rejected.id,
        originAt: harness.observedAt,
        receivedAt: harness.observedAt,
      }),
    );
    await harness.runtime.runPromise(
      harness.repository.approveProposal({
        sink,
        basis: harness.basis,
        proposalId: approved.id,
        task: materializePendingProposal({ proposal: approved }).task,
        dependencyScope: createTaskDependencyScopeCapability({
          topology: backfillTopology,
          basis: harness.basis,
          authoringSink: sink,
        }),
        originAt: harness.observedAt,
        receivedAt: harness.observedAt,
      }),
    );
    const verifiedAgain = await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist: repositoryPersist(harness),
    });
    expect(verifiedAgain.status).toBe("already-complete");
    expect(await taskIds(harness.state)).toEqual([
      approved.id,
      rejected.id,
    ]);
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "complete", objectsIngested: 2 });
  });

  it("keeps a raw same-id collision pending and reopens an older complete marker", async () => {
    const harness = await openHarness();
    const initial = await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist: repositoryPersist(harness),
    });
    expect(initial.status).toBe("complete");

    const { dependsOn: _ignoredDependencies, ...proposalBase } =
      pendingSnapshot;
    const source = {
      ...proposalBase,
      id: "raw-collision",
      brief: {
        ...pendingSnapshot.brief,
        messageId: "raw-collision-brief",
        taskId: "raw-collision",
      },
    };
    const materialization = materializePendingProposal({ proposal: source });
    await harness.runtime.runPromise(
      harness.repository.createTask({
        sink,
        basis: harness.basis,
        task: materialization.task,
        dependencyScope: createTaskDependencyScopeCapability({
          topology: backfillTopology,
          basis: harness.basis,
          authoringSink: sink,
        }),
      }),
    );
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: source.id, details: "Unrelated Task collision." },
    );

    const report = await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist: repositoryPersist(harness),
    });
    expect(report).toMatchObject({
      status: "pending",
      reason: "fixed-point-no-progress",
      materialized: 0,
      skipped: 0,
      failed: 1,
      remaining: 1,
    });
    const page = await harness.runtime.runPromise(
      harness.repository.legacyProposalMaterializationWitnessPage({ limit: 32 }),
    );
    expect(
      page.witnesses.find((entry) => entry.proposalId === source.id),
    ).toMatchObject({
      status: "invalid",
      diagnostic: { code: "task-create-witness-invalid" },
    });
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending", objectsIngested: 0 });
  });

  it("advances past 32 permanent collisions and materializes a later valid row", async () => {
    const harness = await openHarness();
    const dependencyScope = createTaskDependencyScopeCapability({
      topology: backfillTopology,
      basis: harness.basis,
      authoringSink: sink,
    });
    const { dependsOn: _ignoredDependencies, ...proposalBase } =
      pendingSnapshot;
    for (let index = 0; index < 32; index += 1) {
      const id = `a-invalid-${String(index).padStart(2, "0")}`;
      const source = {
        ...proposalBase,
        id,
        brief: {
          ...pendingSnapshot.brief,
          messageId: `${id}-brief`,
          taskId: id,
        },
      };
      await harness.runtime.runPromise(
        harness.repository.createTask({
          sink,
          basis: harness.basis,
          task: materializePendingProposal({ proposal: source }).task,
          dependencyScope,
        }),
      );
      await runtimeCreateProposal(
        harness.repository,
        harness.basis,
        harness.actor,
        harness.observedAt,
        { id, details: `Permanent collision ${index}.` },
      );
    }
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "z-valid", details: "Must not starve." },
    );

    const pageSizes: number[] = [];
    const readWitnessPage: RawBackfillInput["readWitnessPage"] = (input) =>
      harness.repository.legacyProposalMaterializationWitnessPage(input).pipe(
        Effect.tap((page) =>
          Effect.sync(() => pageSizes.push(page.witnesses.length))
        ),
      );
    const backfillInput = {
      state: harness.state,
      installOps: harness.installOps,
      persist: repositoryPersist(harness),
      readWitnessPage,
      limits: { maxPersistAttempts: 32, maxScanRows: 64 },
    };
    const first = await Effect.runPromise(
      runPendingProposalBackfill(backfillInput),
    );
    expect(first).toMatchObject({
      status: "pending",
      reason: "budget-exhausted",
    });
    if (first.status !== "pending" || first.reason !== "budget-exhausted") {
      throw new Error("expected an opaque continuation");
    }
    expect(Object.keys(first.cursor)).toEqual([]);

    const final = await continueBackfillToBoundary(backfillInput, first);
    expect(final).toMatchObject({
      status: "pending",
      reason: "fixed-point-no-progress",
      remaining: 32,
    });
    expect(await taskIds(harness.state)).toContain("z-valid");
    expect(pageSizes.every((size) => size <= 32)).toBe(true);
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("bounds strong decode work independently when one persist attempt is allowed", async () => {
    const harness = await openHarness();
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "a-valid-first", details: "Only this first page is admissible." },
    );
    for (let index = 0; index < 79; index += 1) {
      await runtimeCreateProposal(
        harness.repository,
        harness.basis,
        harness.actor,
        harness.observedAt,
        {
          id: `z-drift-${String(index).padStart(2, "0")}`,
          details: "This later projection will be made invalid.",
        },
      );
    }
    const fallbackPage = await harness.runtime.runPromise(
      harness.repository.legacyProposalMaterializationWitnessPage({ limit: 0 }),
    );
    expect(fallbackPage.witnesses).toHaveLength(32);
    expect(fallbackPage.next).toBeDefined();

    await Effect.runPromise(
      harness.state.transaction("test.drift-later-proposal-pages", (writer) =>
        unjournaledWorkMutation("test.fixture-seed", () => {
          writer.run(
            `UPDATE work_task_proposals
                SET brief_json = ?
              WHERE proposal_id LIKE 'z-drift-%'`,
            [
              canonicalJson({
                messageId: "drifted",
                role: "user",
                parts: [{ kind: "text", text: "different" }],
                taskId: "drifted",
                contextId: "factory",
              }),
            ],
          );
        }),
      ),
    );

    const report = await Effect.runPromise(
      runPendingProposalBackfillRaw({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
        readWitnessPage:
          harness.repository.legacyProposalMaterializationWitnessPage,
        readEpoch: harness.repository.legacyProposalMaterializationEpoch,
        limits: {
          maxPasses: 1,
          maxPersistAttempts: 1,
          maxScanRows: 2,
        },
      }),
    );

    expect(report).toMatchObject({
      status: "pending",
      reason: "budget-exhausted",
      materialized: 1,
      failed: 0,
      remainingExact: false,
    });
    if (report.status !== "pending" || report.reason !== "budget-exhausted") {
      throw new Error("expected one bounded continuation");
    }
    expect(report.cursor).toBeDefined();
    expect(await taskIds(harness.state)).toEqual(["a-valid-first"]);
  });

  it("derives claims only from the exact proposal fact, not an earlier command decoy", async () => {
    const harness = await openHarness();
    const id = "decoy-claims";
    await harness.runtime.runPromise(
      harness.state.transaction("test.seed.proposal-command-decoy", (writer) => {
        const decoyHome = Schema.decodeUnknownSync(InstallationId)(
          "remote-decoy-claims",
        );
        writer.run(
          `INSERT INTO station_known_installations(installation_id, registered_at)
           VALUES (?, ?)`,
          [decoyHome, harness.observedAt],
        );
        const semantic = {
          protocol: WORK_PROTOCOL,
          id: {
            route: {
              eventHome: decoyHome,
              entityHome: harness.installationId,
            },
            seq: allocateSequence(
              writer,
              decoyHome,
              harness.installationId,
            ),
          },
          recordType: "command" as const,
          item: { kind: "proposal" as const, itemId: id, sink },
          operation: "proposal.create" as const,
          predecessor: null,
          body: {
            operation: "proposal.create" as const,
            proposal: {
              id,
              state: "pending" as const,
              brief: {
                messageId: `${id}-decoy-brief`,
                role: "user" as const,
                parts: [{ kind: "text" as const, text: "decoy" }],
                taskId: id,
                contextId: "factory",
              },
              proposedBy: harness.actor,
              claims: [{
                id: "poison",
                text: "Poison claim",
                severity: "hard" as const,
                station: "decoy",
              }],
              metadata: { details: "Decoy command." },
            },
          },
        };
        const record = Schema.decodeUnknownSync(WorkRecord, {
          onExcessProperty: "error",
        })({
          ...semantic,
          contentSha256: workRecordContentSha256(semantic),
          originAt: harness.observedAt,
        });
        appendWorkRecord(writer, record, harness.observedAt);
      }),
    );
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      {
        id,
        details: "Real proposal.",
        claims: [{
          id: "real",
          text: "Real claim",
          severity: "soft",
          station: "qa",
        }],
      },
    );

    const report = await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist: repositoryPersist(harness),
    });
    expect(report.status).toBe("complete");
    const snapshot = await harness.runtime.runPromise(
      harness.repository.readSnapshot(sink.canvasName, sink.nodeId),
    );
    expect(snapshot.tasks.items.find((task) => task.id === id)?.claims).toEqual([
      { id: "real", text: "Real claim", severity: "soft", station: "qa" },
    ]);
  });

  it("leaves the marker pending when persist fails", async () => {
    const { state, repository, installOps, basis, actor, observedAt } =
      await openHarness();
    await runtimeCreateProposal(repository, basis, actor, observedAt, {
      id: "prop-fail",
      details: "Persist will fail.",
    });
    const persist: PersistUnadmittedTask = () =>
      Effect.fail(new Error("persist down"));
    const report = await Effect.runPromise(
      runPendingProposalBackfill({ state, installOps, persist }),
    );
    expect(report).toMatchObject({
      status: "pending",
      materialized: 0,
      failed: 1,
      remaining: 1,
    });
    const marker = await Effect.runPromise(
      installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
    );
    expect(marker?.status).toBe("pending");
  });

  it("times out a stuck persist and returns a continuation report", async () => {
    const harness = await openHarness();
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "stuck-persist", details: "Persist never settles." },
    );

    const report = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: () => Effect.never,
        limits: { persistTimeoutMs: 10 },
      }),
    );

    expect(report).toMatchObject({
      status: "pending",
      materialized: 0,
      skipped: 0,
      failed: 1,
      remaining: 1,
    });
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("reports a rejection between precheck and atomic persist without counting it", async () => {
    const harness = await openHarness();
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "race-rejected", details: "Rejected during reconciliation." },
    );
    let rejected = false;
    let persistStatus: string | undefined;
    const persistTask = repositoryPersist(harness);
    const report = await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist: (input) =>
        Effect.gen(function* () {
          if (!rejected) {
            rejected = true;
            yield* harness.repository.rejectProposal({
              sink,
              basis: harness.basis,
              proposalId: input.proposalId,
              originAt: harness.observedAt,
              receivedAt: harness.observedAt,
            });
          }
          const result = yield* persistTask(input);
          persistStatus = result.status;
          return result;
        }),
    });

    expect(persistStatus).toBe("no-longer-pending");
    expect(report).toMatchObject({
      status: "complete",
      materialized: 0,
      skipped: 0,
      failed: 0,
      remaining: 0,
    });
    expect(await taskIds(harness.state)).not.toContain("race-rejected");
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "complete", objectsIngested: 0 });
  });

  it("drains reverse-order chains and fan-out to a fixed point in one invocation", async () => {
    const harness = await openHarness();
    await seedLegacyProposals(harness, [
      { id: "a-leaf", details: "Leaf.", dependsOn: ["m-mid"] },
      { id: "b-fan", details: "Fan-out sibling.", dependsOn: ["z-root"] },
      { id: "m-mid", details: "Middle.", dependsOn: ["z-root"] },
      { id: "z-root", details: "Root." },
    ]);

    const order: string[] = [];
    const report = await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist: repositoryPersist(harness, order),
    });

    expect(report).toMatchObject({
      status: "complete",
      materialized: 4,
      skipped: 0,
      failed: 0,
      remaining: 0,
    });
    expect(order).toEqual(["z-root", "b-fan", "m-mid", "a-leaf"]);
    expect(await taskIds(harness.state)).toEqual([
      "a-leaf",
      "b-fan",
      "m-mid",
      "z-root",
    ]);
    expect(await taskDependencies(harness.state, "a-leaf")).toEqual(["m-mid"]);
    expect(await taskDependencies(harness.state, "b-fan")).toEqual(["z-root"]);
  });

  it("materializes independent branches while cycles remain pending", async () => {
    const harness = await openHarness();
    await seedLegacyProposals(harness, [
      { id: "cycle-a", details: "Cycle A.", dependsOn: ["cycle-b"] },
      { id: "cycle-b", details: "Cycle B.", dependsOn: ["cycle-a"] },
      { id: "independent", details: "Independent." },
    ]);
    const eventsBefore = await fingerprintProposalEvents(harness.state);

    const report = await runBackfillToBoundary({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
      });

    expect(report).toMatchObject({
      status: "pending",
      reason: "fixed-point-no-progress",
      materialized: 1,
      skipped: 0,
      failed: 2,
      remaining: 2,
    });
    expect(await taskIds(harness.state)).toEqual(["independent"]);
    expect(await fingerprintProposalEvents(harness.state)).toEqual(eventsBefore);
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("returns pending after a bounded pass under continuous ingress", async () => {
    const harness = await openHarness();
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "ingress-seed", details: "Starts the bounded pass." },
    );
    const persistTask = repositoryPersist(harness);
    const arrivals = ["ingress-one", "ingress-two"];
    const persist: PersistUnadmittedTask = (input) => {
      const next = arrivals.shift();
      return persistTask(input).pipe(
        Effect.tap(() =>
          next === undefined
            ? Effect.void
            : Effect.promise(() =>
                runtimeCreateProposal(
                  harness.repository,
                  harness.basis,
                  harness.actor,
                  harness.observedAt,
                  { id: next, details: `Continuous ${next}.` },
                )
              ),
        ),
      );
    };

    const bounded = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist,
        limits: { maxPasses: 2, maxPersistAttempts: 2 },
      }),
    );

    expect(bounded).toMatchObject({
      status: "pending",
      reason: "budget-exhausted",
      materialized: 1,
      skipped: 0,
      failed: 0,
      remainingExact: false,
    });
    expect(await taskIds(harness.state)).toEqual(["ingress-seed"]);
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });

    const continued = await continueBackfillToBoundary(
      {
        state: harness.state,
        installOps: harness.installOps,
        persist,
        limits: { maxPasses: 2, maxPersistAttempts: 2 },
      },
      bounded,
    );
    expect(continued).toMatchObject({
      status: "complete",
      materialized: 3,
      remaining: 0,
    });
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "complete", objectsIngested: 3 });
  });

  it("reconciles a late arrival after a prior complete marker", async () => {
    const harness = await openHarness();
    await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist: repositoryPersist(harness),
    });
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "late-success", details: "Arrived after completion." },
    );

    const report = await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist: repositoryPersist(harness),
    });
    expect(report).toMatchObject({
      status: "complete",
      materialized: 1,
      skipped: 0,
      failed: 0,
      remaining: 0,
    });
    expect(await taskIds(harness.state)).toEqual(["late-success"]);
  });

  it("reopens a prior complete marker when a late row cannot persist", async () => {
    const harness = await openHarness();
    const first = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
      }),
    );
    expect(first.status).toBe("complete");

    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "late-fail", details: "Arrived after the marker." },
    );
    const report = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: () => Effect.fail(new Error("persist unavailable")),
      }),
    );

    expect(report).toMatchObject({
      status: "pending",
      materialized: 0,
      failed: 1,
      remaining: 1,
    });
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending", completedAt: undefined });
  });

  it("rescans after marking and drains an arrival in the scan-to-marker window", async () => {
    const harness = await openHarness();
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "historical", details: "Immutable history witness." },
    );
    await harness.runtime.runPromise(
      harness.repository.rejectProposal({
        sink,
        basis: harness.basis,
        proposalId: "historical",
        originAt: harness.observedAt,
        receivedAt: harness.observedAt,
      }),
    );
    const eventsBefore = await fingerprintProposalEvents(harness.state);
    let injected = false;
    const racingInstallOps = {
      ...harness.installOps,
      markComplete: (id: string, count: number) =>
        harness.installOps.markComplete(id, count).pipe(
          Effect.tap(() => {
            if (injected) return Effect.void;
            injected = true;
            return Effect.promise(() =>
              runtimeCreateProposal(
                harness.repository,
                harness.basis,
                harness.actor,
                harness.observedAt,
                { id: "raced", details: "Arrived while marking." },
              ),
            );
          }),
        ),
    };

    const backfillInput = {
      state: harness.state,
      installOps: racingInstallOps,
      persist: repositoryPersist(harness),
    };
    const first = await Effect.runPromise(
      runPendingProposalBackfill(backfillInput),
    );
    expect(first).toMatchObject({
      status: "pending",
      reason: "budget-exhausted",
    });
    const report = await continueBackfillToBoundary(backfillInput, first);

    expect(report).toMatchObject({
      status: "complete",
      materialized: 1,
      skipped: 0,
      failed: 0,
      remaining: 0,
    });
    expect(await taskIds(harness.state)).toEqual(["raced"]);
    expect(await fingerprintProposalEvents(harness.state)).toEqual(
      expect.arrayContaining([...eventsBefore]),
    );
  });

  it("reopens a completed marker when the post-marker sweep finds a collision", async () => {
    const harness = await openHarness();
    const { dependsOn: _ignoredDependencies, ...proposalBase } =
      pendingSnapshot;
    const source = {
      ...proposalBase,
      id: "post-marker-collision",
      brief: {
        ...pendingSnapshot.brief,
        messageId: "post-marker-collision-brief",
        taskId: "post-marker-collision",
      },
      proposedBy: harness.actor,
    };
    let injected = false;
    const racingInstallOps = {
      ...harness.installOps,
      markComplete: (id: string, count: number) =>
        harness.installOps.markComplete(id, count).pipe(
          Effect.tap(() => {
            if (injected) return Effect.void;
            injected = true;
            const materialization = materializePendingProposal({
              proposal: source,
            });
            return Effect.gen(function* () {
              yield* harness.repository.createTask({
                sink,
                basis: harness.basis,
                task: materialization.task,
                dependencyScope: createTaskDependencyScopeCapability({
                  topology: backfillTopology,
                  basis: harness.basis,
                  authoringSink: sink,
                }),
              });
              yield* harness.repository.createProposal({
                sink,
                basis: harness.basis,
                proposal: source,
                originAt: harness.observedAt,
                receivedAt: harness.observedAt,
              });
            }).pipe(Effect.orDie);
          }),
        ),
    };
    const input = {
      state: harness.state,
      installOps: racingInstallOps,
      persist: repositoryPersist(harness),
    };

    const first = await Effect.runPromise(runPendingProposalBackfill(input));
    expect(first).toMatchObject({
      status: "pending",
      reason: "budget-exhausted",
    });
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });

    const parked = await continueBackfillToBoundary(input, first);
    expect(parked).toMatchObject({
      status: "pending",
      reason: "fixed-point-no-progress",
      failed: 1,
      remaining: 1,
    });
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("discovers an arrival committed immediately after marker completion", async () => {
    const harness = await openHarness();
    const first = await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist: repositoryPersist(harness),
    });
    expect(first.status).toBe("complete");

    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      {
        id: "after-marker-completion",
        details: "Arrived after the marker was committed.",
      },
    );
    const next = await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist: repositoryPersist(harness),
    });
    expect(next).toMatchObject({
      status: "complete",
      materialized: 1,
      failed: 0,
      remaining: 0,
    });
    expect(await taskIds(harness.state)).toContain("after-marker-completion");
  });

  it("resumes after interruption without replaying the first durable task", async () => {
    const harness = await openHarness();
    await seedLegacyProposals(harness, [
      { id: "child", details: "Child.", dependsOn: ["root"] },
      { id: "root", details: "Root." },
    ]);
    const persist = repositoryPersist(harness);
    let rootCreated = false;
    const crashingPersist: PersistUnadmittedTask = (input) => {
      if (input.proposalId === "root") {
        return persist(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              rootCreated = true;
            })
          ),
        );
      }
      return rootCreated
        ? Effect.die(new Error("simulated crash"))
        : persist(input);
    };

    await expect(
      Effect.runPromise(
        runPendingProposalBackfill({
          state: harness.state,
          installOps: harness.installOps,
          persist: crashingPersist,
        }),
      ),
    ).rejects.toThrow(/simulated crash/);
    expect(await taskIds(harness.state)).toEqual(["root"]);
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });

    const resumed = await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist,
    });
    expect(resumed).toMatchObject({
      status: "complete",
      materialized: 1,
      skipped: 1,
      failed: 0,
      remaining: 0,
    });
    expect(await taskIds(harness.state)).toEqual(["child", "root"]);
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "complete", objectsIngested: 2 });

    const exactAgain = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist,
      }),
    );
    expect(exactAgain.status).toBe("already-complete");
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "complete", objectsIngested: 2 });
  });

  it("fails malformed explicit planning data without widening an independent branch", async () => {
    const harness = await openHarness();
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "bad-shape", details: "Bad explicit shape." },
    );
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "still-independent", details: "Independent." },
    );
    await harness.runtime.runPromise(
      harness.state.transaction("test.seed.old-planning-shape", (writer) =>
        unjournaledWorkMutation("test.fixture-seed", () => {
          writer.run(
            `
              INSERT INTO work_proposal_planning(
                canvas_name,
                node_id,
                proposal_id,
                depends_on_json
              ) VALUES (?, ?, ?, ?)
              ON CONFLICT(canvas_name, node_id, proposal_id) DO UPDATE SET
                depends_on_json = excluded.depends_on_json
            `,
            [
              sink.canvasName,
              sink.nodeId,
              "bad-shape",
              JSON.stringify("missing"),
            ],
          );
        }),
      ),
    );
    const eventsBefore = await fingerprintProposalEvents(harness.state);

    const report = await runBackfillToBoundary({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
      });

    expect(report).toMatchObject({
      status: "pending",
      materialized: 1,
      skipped: 0,
      failed: 1,
      remaining: 1,
    });
    expect(await taskIds(harness.state)).toEqual(["still-independent"]);
    expect(await fingerprintProposalEvents(harness.state)).toEqual(eventsBefore);
  });

  it("counts invalid finishCriteria before frontier planning instead of defecting", async () => {
    const harness = await openHarness();
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      {
        id: "bad-finish",
        details: "Invalid historical finish criteria.",
      },
    );
    await harness.runtime.runPromise(
      harness.state.transaction("test.seed.invalid-finish", (writer) =>
        unjournaledWorkMutation("test.fixture-seed", () => {
          writer.run(
            `
              INSERT INTO work_proposal_planning(
                canvas_name,
                node_id,
                proposal_id,
                depends_on_json,
                finish_criteria_json
              ) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(canvas_name, node_id, proposal_id) DO UPDATE SET
                depends_on_json = excluded.depends_on_json,
                finish_criteria_json = excluded.finish_criteria_json
            `,
            [
              sink.canvasName,
              sink.nodeId,
              "bad-finish",
              JSON.stringify(["still-missing"]),
              JSON.stringify({ description: 42 }),
            ],
          );
        }),
      ),
    );

    let persistCalled = false;
    const report = await runBackfillToBoundary({
        state: harness.state,
        installOps: harness.installOps,
        persist: () => {
          persistCalled = true;
          return Effect.die(new Error("invalid row reached persist"));
        },
      });

    expect(report).toMatchObject({
      status: "pending",
      materialized: 0,
      skipped: 0,
      failed: 1,
      remaining: 1,
    });
    expect(persistCalled).toBe(false);
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("brackets completion with the relevant epoch and reopens on failure or interruption", async () => {
    const raced = await openHarness();
    let epochReads = 0;
    const epochRace = () => {
      epochReads += 1;
      return epochReads >= 4 ? 1 : 0;
    };
    const racedReport = await Effect.runPromise(
      runPendingProposalBackfill({
        state: raced.state,
        installOps: raced.installOps,
        persist: repositoryPersist(raced),
        readEpoch: epochRace,
      }),
    );
    expect(racedReport).toMatchObject({
      status: "pending",
      reason: "budget-exhausted",
    });
    expect(
      await Effect.runPromise(
        raced.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });

    const failed = await openHarness();
    const failedCalls: string[] = [];
    const failingInstallOps = {
      ...failed.installOps,
      markComplete: (id: string, count: number) =>
        failed.installOps.markComplete(id, count).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              failedCalls.push("mark");
              throw new Error("post-marker verification defect");
            })
          ),
        ),
      reopenPending: (id: string) =>
        Effect.sync(() => failedCalls.push("reopen")).pipe(
          Effect.andThen(failed.installOps.reopenPending(id)),
        ),
    };
    await expect(
      Effect.runPromise(
        runPendingProposalBackfill({
          state: failed.state,
          installOps: failingInstallOps,
          persist: repositoryPersist(failed),
        }),
      ),
    ).rejects.toThrow(/post-marker verification defect/);
    expect(failedCalls).toContain("reopen");
    expect(
      await Effect.runPromise(
        failed.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });

    const interrupted = await openHarness();
    let interruptedReopens = 0;
    const interruptingInstallOps = {
      ...interrupted.installOps,
      markComplete: (id: string, count: number) =>
        interrupted.installOps.markComplete(id, count).pipe(
          Effect.andThen(Effect.interrupt),
        ),
      reopenPending: (id: string) =>
        Effect.sync(() => {
          interruptedReopens += 1;
        }).pipe(Effect.andThen(interrupted.installOps.reopenPending(id))),
    };
    await expect(
      Effect.runPromise(
        runPendingProposalBackfill({
          state: interrupted.state,
          installOps: interruptingInstallOps,
          persist: repositoryPersist(interrupted),
        }),
      ),
    ).rejects.toThrow();
    expect(interruptedReopens).toBeGreaterThan(0);
    expect(
      await Effect.runPromise(
        interrupted.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });
  });

  it("does not infer dependsOn from proposal prose", async () => {
    const harness = await openHarness();
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      {
        id: "prose-only",
        details: "Depends on missing-task before this may start.",
        briefText: "Prerequisite: missing-task",
      },
    );

    const report = await runBackfillToBoundary({
      state: harness.state,
      installOps: harness.installOps,
      persist: repositoryPersist(harness),
    });
    expect(report.status).toBe("complete");
    expect(await taskDependencies(harness.state, "prose-only")).toEqual([]);
  });
});

describe("InstallOpsService.reopenPending", () => {
  it("is idempotent and preserves the prior ingest count", async () => {
    const { installOps } = await openHarness();
    await Effect.runPromise(installOps.markComplete("test.reopen", 7));
    await Effect.runPromise(installOps.reopenPending("test.reopen"));
    await Effect.runPromise(installOps.reopenPending("test.reopen"));

    expect(await Effect.runPromise(installOps.getBackfill("test.reopen"))).toEqual({
      id: "test.reopen",
      status: "pending",
      objectsIngested: 7,
      completedAt: undefined,
    });
  });
});

describe("pending-proposal backfill — GO fields", () => {
  it("stamps Task.admission and Task.raisedBy on the materialized task", () => {
    const out = materializePendingProposal({
      proposal: {
        id: "prop-1",
        state: "pending",
        brief: {
          messageId: "m1",
          role: "user",
          parts: [{ kind: "text", text: "Do it" }],
        },
        proposedBy,
        metadata: { details: "Do it" },
      },
    });
    expect(out.task.admission).toBe("operator-gated");
    expect(out.task.raisedBy).toEqual(proposedBy);
  });
});

type Harness = Awaited<ReturnType<typeof openHarness>>;

/** Seed one exact legacy proposal.create fact per immutable identity. */
type LegacyProposalSeed = {
  readonly id: string;
  readonly details: string;
  readonly dependsOn?: ReadonlyArray<string>;
};

const seedLegacyProposals = async (
  harness: Harness,
  entries: ReadonlyArray<LegacyProposalSeed>,
): Promise<void> => {
  const decodeRecord = Schema.decodeUnknownSync(WorkRecord, {
    onExcessProperty: "error",
  });
  await harness.runtime.runPromise(
    harness.state.transaction("test.seed.legacy-proposals", (writer) =>
      unjournaledWorkMutation("test.fixture-seed", () => {
        for (const entry of entries) {
          const semantic: Omit<
            WorkFactValue,
            "contentSha256" | "originAt"
          > = {
            protocol: WORK_PROTOCOL,
            id: {
              route: {
                eventHome: harness.installationId,
                entityHome: harness.installationId,
              },
              seq: allocateSequence(
                writer,
                harness.installationId,
                harness.installationId,
              ),
            },
            recordType: "fact",
            item: {
              kind: "proposal",
              itemId: entry.id,
              sink,
            },
            operation: "proposal.create",
            predecessor: null,
            basis: harness.basis,
            body: {
              operation: "proposal.create",
              proposal: {
                id: entry.id,
                state: "pending",
                brief: {
                  messageId: `${entry.id}-brief`,
                  role: "agent",
                  parts: [{ kind: "text", text: entry.id }],
                  taskId: entry.id,
                  contextId: "factory",
                },
                proposedBy: harness.actor,
                metadata: { details: entry.details },
                ...(entry.dependsOn === undefined
                  ? {}
                  : { dependsOn: entry.dependsOn }),
              },
            },
          };
          const record = decodeRecord({
            ...semantic,
            contentSha256: workRecordContentSha256(semantic),
            originAt: harness.observedAt,
          });
          if (
            record.recordType !== "fact" ||
            record.body.operation !== "proposal.create"
          ) {
            throw new Error(`invalid legacy proposal fixture ${entry.id}`);
          }
          const proposal = record.body.proposal;
          appendWorkRecord(writer, record, record.originAt);
          writer.run(
            `
              INSERT INTO work_task_proposals(
                canvas_name,
                node_id,
                proposal_id,
                entity_home,
                fact_event_home,
                fact_entity_home,
                fact_seq,
                state,
                brief_json,
                proposer_seat_id,
                proposer_canvas_name,
                proposer_node_id,
                approved_task_id,
                metadata_json,
                reason,
                created_at,
                updated_at,
                origin_at,
                received_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?)
            `,
            [
              sink.canvasName,
              sink.nodeId,
              proposal.id,
              record.id.route.entityHome,
              record.id.route.eventHome,
              record.id.route.entityHome,
              record.id.seq,
              proposal.state,
              canonicalJson(proposal.brief),
              proposal.proposedBy.seatId,
              proposal.proposedBy.canvasName,
              proposal.proposedBy.nodeId,
              proposal.metadata === undefined
                ? null
                : canonicalJson(proposal.metadata),
              record.originAt,
              record.originAt,
              record.originAt,
              record.originAt,
            ],
          );
          if ((proposal.dependsOn?.length ?? 0) > 0) {
            writer.run(
              `
                INSERT INTO work_proposal_planning(
                  canvas_name,
                  node_id,
                  proposal_id,
                  depends_on_json,
                  finish_criteria_json
                ) VALUES (?, ?, ?, ?, NULL)
              `,
              [
                sink.canvasName,
                sink.nodeId,
                proposal.id,
                canonicalJson(proposal.dependsOn),
              ],
            );
          }
        }
      }),
    ),
  );
};

const runtimeCreateProposal = async (
  repository: Harness["repository"],
  basis: Harness["basis"],
  actor: Harness["actor"],
  observedAt: string,
  input: {
    readonly id: string;
    readonly details: string;
    readonly briefText?: string;
    readonly dependsOn?: ReadonlyArray<string>;
    readonly claims?: ReadonlyArray<{
      readonly id: string;
      readonly text: string;
      readonly severity: "hard" | "soft";
      readonly station: string;
    }>;
  },
) => {
  await Effect.runPromise(
    repository.createProposal({
      sink,
      basis,
      dependencyScope: createTaskDependencyScopeCapability({
        topology: backfillTopology,
        basis,
        authoringSink: sink,
      }),
      proposal: {
        id: input.id,
        state: "pending",
        brief: {
          messageId: `${input.id}-brief`,
          role: "agent",
          parts: [{ kind: "text", text: input.briefText ?? input.id }],
          taskId: input.id,
          contextId: "factory",
        },
        proposedBy: actor,
        metadata: { details: input.details },
        ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
        ...(input.claims !== undefined ? { claims: input.claims } : {}),
      },
      originAt: observedAt,
      receivedAt: observedAt,
    }),
  );
};

const repositoryPersist = (
  harness: Harness,
  order?: string[],
): PersistUnadmittedTask => (input) => {
  return harness.repository.persistUnadmittedTask({
    sink: { canvasName: input.canvasName, nodeId: input.nodeId },
    proposalId: input.proposalId,
    home: harness.installationId,
    basis: harness.basis,
    dependencyScope: createTaskDependencyScopeCapability({
      topology: backfillTopology,
      basis: harness.basis,
      authoringSink: {
        canvasName: input.canvasName,
        nodeId: input.nodeId,
      },
    }),
  }).pipe(
    Effect.tap((result) =>
      result.status === "created"
        ? Effect.sync(() => order?.push(input.proposalId))
        : Effect.void
    ),
  );
};

const taskIds = (state: Harness["state"]) =>
  Effect.runPromise(
    state.read("assert.task-ids", (reader) =>
      reader.all<{ readonly task_id: string }>(
        `
          SELECT task_id
          FROM work_tasks
          WHERE canvas_name = ? AND node_id = ?
          ORDER BY task_id
        `,
        [sink.canvasName, sink.nodeId],
      ).map((row) => row.task_id),
    ),
  );

const taskDependencies = (state: Harness["state"], taskId: string) =>
  Effect.runPromise(
    state.read("assert.task-dependencies", (reader) =>
      reader.all<{ readonly depends_on_task_id: string }>(
        `
          SELECT depends_on_task_id
          FROM work_task_dependencies
          WHERE canvas_name = ? AND node_id = ? AND task_id = ?
          ORDER BY position
        `,
        [sink.canvasName, sink.nodeId, taskId],
      ).map((row) => row.depends_on_task_id),
    ),
  );

const fingerprintProposalEvents = (state: Harness["state"]) =>
  Effect.runPromise(
    state.read("fingerprint.proposal-events", (reader) =>
      reader.all<{
        readonly eventHome: string;
        readonly entityHome: string;
        readonly seq: string;
        readonly recordType: string;
        readonly canvasName: string;
        readonly nodeId: string;
        readonly proposalId: string;
        readonly operation: string;
        readonly sha: string;
        readonly json: string;
        readonly originAt: string;
        readonly receivedAt: string;
      }>(
        `
          SELECT
            event_home AS eventHome,
            entity_home AS entityHome,
            seq,
            record_type AS recordType,
            canvas_name AS canvasName,
            node_id AS nodeId,
            proposal_id AS proposalId,
            operation,
            content_sha256 AS sha,
            record_json AS json,
            origin_at AS originAt,
            received_at AS receivedAt
          FROM work_proposal_events
          ORDER BY event_home, entity_home, length(seq), seq
        `,
      ),
    ),
  );
