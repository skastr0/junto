import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
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
import { InstallationId } from "../src/shared/installation-id";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { ActorRef } from "../src/shared/work-reference";
import {
  runPendingProposalBackfill,
  type PersistUnadmittedTask,
} from "../src/main/vellum/work/pending-proposal-backfill";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import { unjournaledWorkMutation } from "../src/main/vellum/work/mutation-seam";
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
         ) VALUES ('1', 'factory', '{}', ?, ?)`,
        ["1".repeat(64), observedAt],
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
  return { runtime, state, repository, installOps, basis, actor, observedAt };
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

    const persist: PersistUnadmittedTask = () => Effect.void;
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
      return repository.createTask({
        sink: { canvasName: input.canvasName, nodeId: input.nodeId },
        basis,
        task: input.materialization.task,
        originAt: observedAt,
        receivedAt: observedAt,
      }).pipe(Effect.asVoid);
    };

    const report = await Effect.runPromise(
      runPendingProposalBackfill({ state, installOps, persist }),
    );
    expect(report.status).toBe("complete");
    expect(report.materialized).toBe(1);
    expect(captured?.materialization.admission).toBe("operator-gated");
    expect(captured?.materialization.raisedBy).toEqual(actor);
    expect(captured?.materialization.task.claims).toEqual([
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

  it("counts a durable same-id pair after its proposal leaves pending", async () => {
    const harness = await openHarness();
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "materialized-then-rejected", details: "Durable pair witness." },
    );
    const persistTask = repositoryPersist(harness);
    const persist: PersistUnadmittedTask = (input) =>
      persistTask(input).pipe(
        Effect.andThen(
          harness.repository.rejectProposal({
            sink,
            basis: harness.basis,
            proposalId: input.materialization.task.id,
            originAt: harness.observedAt,
            receivedAt: harness.observedAt,
          }).pipe(Effect.asVoid),
        ),
      );

    const report = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist,
      }),
    );

    expect(report).toEqual({
      status: "complete",
      materialized: 1,
      skipped: 0,
      failed: 0,
      remaining: 0,
    });
    expect(await taskIds(harness.state)).toContain("materialized-then-rejected");
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "complete", objectsIngested: 1 });
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

    expect(report).toEqual({
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
    const racingState: Parameters<
      typeof runPendingProposalBackfill
    >[0]["state"] = {
      read: (operation, body) =>
        harness.state.read(operation, body).pipe(
          Effect.tap(() => {
            if (
              rejected ||
              operation !== "work.pending-proposals.pre-persist"
            ) {
              return Effect.void;
            }
            rejected = true;
            return harness.repository.rejectProposal({
              sink,
              basis: harness.basis,
              proposalId: "race-rejected",
              originAt: harness.observedAt,
              receivedAt: harness.observedAt,
            }).pipe(Effect.asVoid);
          }),
        ),
    };
    let persistCalled = false;
    const report = await Effect.runPromise(
      runPendingProposalBackfill({
        state: racingState,
        installOps: harness.installOps,
        persist: () => {
          persistCalled = true;
          return Effect.fail(new Error("atomic persist saw non-pending"));
        },
      }),
    );

    expect(persistCalled).toBe(true);
    expect(report).toEqual({
      status: "complete",
      materialized: 0,
      skipped: 0,
      failed: 1,
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
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "a-leaf", details: "Leaf.", dependsOn: ["m-mid"] },
    );
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "b-fan", details: "Fan-out sibling.", dependsOn: ["z-root"] },
    );
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "m-mid", details: "Middle.", dependsOn: ["z-root"] },
    );
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "z-root", details: "Root." },
    );

    const order: string[] = [];
    const report = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness, order),
      }),
    );

    expect(report).toEqual({
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
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "cycle-a", details: "Cycle A.", dependsOn: ["cycle-b"] },
    );
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "cycle-b", details: "Cycle B.", dependsOn: ["cycle-a"] },
    );
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "independent", details: "Independent." },
    );
    const eventsBefore = await fingerprintProposalEvents(harness.state);

    const report = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
      }),
    );

    expect(report).toEqual({
      status: "pending",
      materialized: 1,
      skipped: 0,
      failed: 0,
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
        Effect.andThen(
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

    expect(bounded).toEqual({
      status: "pending",
      materialized: 2,
      skipped: 0,
      failed: 0,
      remaining: 1,
    });
    expect(await taskIds(harness.state)).toEqual([
      "ingress-one",
      "ingress-seed",
    ]);
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });

    const continued = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
      }),
    );
    expect(continued).toMatchObject({
      status: "complete",
      materialized: 1,
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
    await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
      }),
    );
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "late-success", details: "Arrived after completion." },
    );

    const report = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
      }),
    );
    expect(report).toEqual({
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

    const report = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: racingInstallOps,
        persist: repositoryPersist(harness),
      }),
    );

    expect(report).toEqual({
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

  it("discovers on the next pass an arrival after the post-marker snapshot", async () => {
    const harness = await openHarness();
    let injected = false;
    const racingState: Parameters<
      typeof runPendingProposalBackfill
    >[0]["state"] = {
      read: (operation, body) =>
        harness.state.read(operation, body).pipe(
          Effect.tap(() => {
            if (
              injected ||
              operation !== "work.pending-proposals.post-marker-scan"
            ) {
              return Effect.void;
            }
            injected = true;
            return Effect.promise(() =>
              runtimeCreateProposal(
                harness.repository,
                harness.basis,
                harness.actor,
                harness.observedAt,
                {
                  id: "after-post-marker",
                  details: "Arrived after the product snapshot.",
                },
              )
            );
          }),
        ),
    };

    const first = await Effect.runPromise(
      runPendingProposalBackfill({
        state: racingState,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
      }),
    );
    expect(first.status).toBe("complete");
    expect(await taskIds(harness.state)).not.toContain("after-post-marker");

    const next = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
      }),
    );
    expect(next).toMatchObject({
      status: "complete",
      materialized: 1,
      failed: 0,
      remaining: 0,
    });
    expect(await taskIds(harness.state)).toContain("after-post-marker");
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "complete", objectsIngested: 1 });
  });

  it("resumes after interruption without replaying the first durable task", async () => {
    const harness = await openHarness();
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "child", details: "Child.", dependsOn: ["root"] },
    );
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "root", details: "Root." },
    );
    const persist = repositoryPersist(harness);
    const crashingPersist: PersistUnadmittedTask = (input) =>
      input.materialization.task.id === "root"
        ? persist(input)
        : Effect.die(new Error("simulated crash"));

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

    const resumed = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist,
      }),
    );
    expect(resumed).toEqual({
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
      { id: "bad-shape", details: "Bad explicit shape.", dependsOn: ["missing"] },
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
              UPDATE work_proposal_planning
              SET depends_on_json = ?
              WHERE canvas_name = ? AND node_id = ? AND proposal_id = ?
            `,
            [JSON.stringify("missing"), sink.canvasName, sink.nodeId, "bad-shape"],
          );
        }),
      ),
    );
    const eventsBefore = await fingerprintProposalEvents(harness.state);

    const report = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
      }),
    );

    expect(report).toEqual({
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
    const report = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: () => {
          persistCalled = true;
          return Effect.die(new Error("invalid row reached persist"));
        },
      }),
    );

    expect(report).toEqual({
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

  it("verifies full immutable rows before completion and reopens on later errors", async () => {
    const harness = await openHarness();
    await runtimeCreateProposal(
      harness.repository,
      harness.basis,
      harness.actor,
      harness.observedAt,
      { id: "event-witness", details: "Immutable event witness." },
    );
    await harness.runtime.runPromise(
      harness.repository.rejectProposal({
        sink,
        basis: harness.basis,
        proposalId: "event-witness",
        originAt: harness.observedAt,
        receivedAt: harness.observedAt,
      }),
    );
    await Effect.runPromise(
      harness.installOps.ensurePending(BACKFILL_PENDING_PROPOSALS_V1),
    );

    const calls: string[] = [];
    let verification = 0;
    const stateWithSecondVerificationError: Parameters<
      typeof runPendingProposalBackfill
    >[0]["state"] = {
      read: (operation, body) =>
        harness.state.read(operation, body).pipe(
          Effect.map((value) => {
            if (operation !== "work.pending-proposals.fingerprint-after") {
              return value;
            }
            verification += 1;
            calls.push(`verify-${verification}`);
            if (verification !== 2) return value;
            const rows = value as ReadonlyArray<Record<string, unknown>>;
            return rows.map((row, index) =>
              index === 0
                ? { ...row, originAt: `${String(row.originAt)}-changed` }
                : row
            ) as typeof value;
          }),
        ),
    };
    const loggingInstallOps = {
      ...harness.installOps,
      markComplete: (id: string, count: number) =>
        Effect.sync(() => calls.push("mark")).pipe(
          Effect.andThen(harness.installOps.markComplete(id, count)),
        ),
      reopenPending: (id: string) =>
        Effect.sync(() => calls.push("reopen")).pipe(
          Effect.andThen(harness.installOps.reopenPending(id)),
        ),
    };

    await expect(
      Effect.runPromise(
        runPendingProposalBackfill({
          state: stateWithSecondVerificationError,
          installOps: loggingInstallOps,
          persist: repositoryPersist(harness),
        }),
      ),
    ).rejects.toThrow(/preexisting work_proposal_events row changed/);
    expect(calls).toEqual(["verify-1", "mark", "verify-2", "reopen"]);
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
      ),
    ).toMatchObject({ status: "pending" });

    await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
      }),
    );
    calls.length = 0;
    verification = 0;
    const stateWithImmediateVerificationError: Parameters<
      typeof runPendingProposalBackfill
    >[0]["state"] = {
      read: (operation, body) =>
        harness.state.read(operation, body).pipe(
          Effect.map((value) => {
            if (operation !== "work.pending-proposals.fingerprint-after") {
              return value;
            }
            verification += 1;
            calls.push(`verify-${verification}`);
            const rows = value as ReadonlyArray<Record<string, unknown>>;
            return rows.map((row, index) =>
              index === 0
                ? { ...row, receivedAt: `${String(row.receivedAt)}-changed` }
                : row
            ) as typeof value;
          }),
        ),
    };
    await expect(
      Effect.runPromise(
        runPendingProposalBackfill({
          state: stateWithImmediateVerificationError,
          installOps: loggingInstallOps,
          persist: repositoryPersist(harness),
        }),
      ),
    ).rejects.toThrow(/preexisting work_proposal_events row changed/);
    expect(calls).toEqual(["verify-1", "reopen"]);
    expect(
      await Effect.runPromise(
        harness.installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
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

    const report = await Effect.runPromise(
      runPendingProposalBackfill({
        state: harness.state,
        installOps: harness.installOps,
        persist: repositoryPersist(harness),
      }),
    );
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
  order?.push(input.materialization.task.id);
  return harness.repository.createTask({
    sink: { canvasName: input.canvasName, nodeId: input.nodeId },
    basis: harness.basis,
    task: input.materialization.task,
    originAt: harness.observedAt,
    receivedAt: harness.observedAt,
  }).pipe(Effect.asVoid);
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
