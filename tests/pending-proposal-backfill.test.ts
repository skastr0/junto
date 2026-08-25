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
    expect(report.status).toBe("pending");
    expect(report.materialized).toBe(1);

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

  it("leaves the marker pending when persist fails", async () => {
    const { state, repository, installOps, basis, actor, observedAt } =
      await openHarness();
    await runtimeCreateProposal(repository, basis, actor, observedAt, {
      id: "prop-fail",
      details: "Persist will fail.",
    });
    const persist: PersistUnadmittedTask = () =>
      Effect.fail(new Error("persist down"));
    await expect(
      Effect.runPromise(
        runPendingProposalBackfill({ state, installOps, persist }),
      ),
    ).rejects.toThrow(/persist down/);
    const marker = await Effect.runPromise(
      installOps.getBackfill(BACKFILL_PENDING_PROPOSALS_V1),
    );
    expect(marker?.status).toBe("pending");
  });
});

describe.skip("pending-proposal backfill — GO gates", () => {
  it("stamps Task.admission and Task.raisedBy on the durable row", () => {
    // GO: first-class Task.admission / Task.raisedBy, then persist through
    // repository without a second writer. Until then the overlay lives on
    // UnadmittedMaterialization only.
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
          parts: [{ kind: "text", text: input.id }],
          taskId: input.id,
          contextId: "factory",
        },
        proposedBy: actor,
        metadata: { details: input.details },
        ...(input.claims !== undefined ? { claims: input.claims } : {}),
      },
      originAt: observedAt,
      receivedAt: observedAt,
    }),
  );
};

const fingerprintProposalEvents = (state: Harness["state"]) =>
  Effect.runPromise(
    state.read("fingerprint.proposal-events", (reader) =>
      reader.all<{
        readonly seq: string;
        readonly sha: string;
        readonly json: string;
      }>(
        `
          SELECT seq, content_sha256 AS sha, record_json AS json
          FROM work_proposal_events
          ORDER BY event_home, entity_home, length(seq), seq
        `,
      ),
    ),
  );
