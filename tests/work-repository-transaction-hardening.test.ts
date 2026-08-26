import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorkRepository,
  WorkRepositoryLive,
  type TaskDependencyScopeWitness,
} from "../src/main/vellum/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import { materializePendingProposal } from "../src/shared/pending-proposal-backfill";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import type {
  Task,
  TaskProposal,
} from "../src/shared/work-model";
import { IntentFactBasis } from "../src/shared/work-protocol";
import type { ActorRef } from "../src/shared/work-reference";

const root = join(
  tmpdir(),
  `vellum-command-work-transaction-hardening-${randomUUID()}`,
);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "vellum-command.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const observedAt = "2026-08-26T18:00:00.000Z";
const installationId = Schema.decodeUnknownSync(InstallationId)(
  "cc-work-transaction-hardening",
);
const remoteInstallationId = Schema.decodeUnknownSync(InstallationId)(
  "remote-work-transaction-hardening",
);
const intentSha256 = "a".repeat(64);
const basis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
})({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: intentSha256,
});
const staleBasis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
})({
  kind: "authorial-intent",
  generation: "0",
  contentSha256: "b".repeat(64),
});
const canvasBody = JSON.stringify({ nodes: [], edges: [] });

const actor = (digit: string, nodeId = `worker-${digit}`): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`),
  canvasName: "factory",
  nodeId,
});

const scope = (
  nodeId: string,
  allowedTaskSinkNodeIds: ReadonlyArray<string>,
  overrides?: Partial<TaskDependencyScopeWitness>,
): TaskDependencyScopeWitness => ({
  canvasName: "factory",
  nodeId,
  basis,
  allowedTaskSinkNodeIds,
  ...overrides,
});

const message = (id: string, text = id) => ({
  messageId: `message-${id}`,
  role: "user" as const,
  parts: [{ kind: "text" as const, text }],
  taskId: id,
  contextId: "factory",
});

const task = (
  id: string,
  options?: {
    readonly dependsOn?: ReadonlyArray<string>;
    readonly admission?: Task["admission"];
    readonly holdUntil?: string;
    readonly raisedBy?: ActorRef;
  },
): Task => ({
  id,
  state: "submitted",
  history: [message(id)],
  metadata: { title: id, details: `${id} details` },
  ...(options?.dependsOn === undefined
    ? {}
    : { dependsOn: [...options.dependsOn] }),
  ...(options?.admission === undefined
    ? {}
    : { admission: options.admission }),
  ...(options?.holdUntil === undefined
    ? {}
    : { holdUntil: options.holdUntil }),
  ...(options?.raisedBy === undefined
    ? {}
    : { raisedBy: options.raisedBy }),
});

const proposal = (
  id: string,
  proposedBy: ActorRef,
  options?: { readonly dependsOn?: ReadonlyArray<string> },
): TaskProposal => ({
  id,
  state: "pending",
  brief: {
    ...message(id, `brief ${id}`),
    referenceTaskIds: [`reference-${id}`],
    metadata: { source: "legacy" },
  },
  proposedBy,
  ...(options?.dependsOn === undefined
    ? {}
    : { dependsOn: [...options.dependsOn] }),
  finishCriteria: {
    description: `finish ${id}`,
    git: { minCommits: 1 },
  },
  claims: [
    {
      id: `claim-${id}`,
      text: `claim ${id}`,
      severity: "hard",
      station: "tasks-main",
    },
  ],
  metadata: { title: id, details: `proposal ${id}` },
  reason: `reason ${id}`,
});

const sink = (nodeId: string) => ({ canvasName: "factory", nodeId });

const seed = () =>
  state.transaction("test.seed", (writer) => {
    writer.run(
      `INSERT INTO station_known_installations(installation_id, registered_at)
       VALUES (?, ?), (?, ?)`,
      [installationId, observedAt, remoteInstallationId, observedAt],
    );
    writer.run(
      `INSERT INTO station_installation(singleton, installation_id, created_at)
       VALUES (1, ?, ?)`,
      [installationId, observedAt],
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
      [observedAt, intentSha256],
    );
    writer.run(
      `INSERT INTO canvas_generation_documents(
         generation, name, body, sha256, modified_at
       ) VALUES ('1', 'factory', ?, ?, ?)`,
      [
        canvasBody,
        createHash("sha256").update(canvasBody).digest("hex"),
        observedAt,
      ],
    );
    writer.run(`INSERT INTO canvas_head(singleton, generation) VALUES (1, '1')`);
  });

beforeAll(async () => {
  repository = await runtime.runPromise(WorkRepository);
  state = await runtime.runPromise(StateEngine);
  await runtime.runPromise(seed());
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const createTask = async (
  nodeId: string,
  value: Task,
  dependencyScope?: TaskDependencyScopeWitness,
) =>
  runtime.runPromise(
    repository.createTask({
      sink: sink(nodeId),
      basis,
      task: value,
      ...(dependencyScope === undefined ? {} : { dependencyScope }),
      originAt: observedAt,
      receivedAt: observedAt,
    }),
  );

const createProposal = async (
  nodeId: string,
  value: TaskProposal,
  dependencyScope?: TaskDependencyScopeWitness,
) =>
  runtime.runPromise(
    repository.createProposal({
      sink: sink(nodeId),
      basis,
      proposal: value,
      ...(dependencyScope === undefined ? {} : { dependencyScope }),
      originAt: observedAt,
      receivedAt: observedAt,
    }),
  );

const taskAt = async (nodeId: string, taskId: string): Promise<Task | undefined> => {
  const snapshot = await runtime.runPromise(
    repository.readSnapshot("factory", nodeId),
  );
  return snapshot.tasks.items.find((item) => item.id === taskId);
};

const taskCreateCount = (nodeId: string, taskId: string) =>
  runtime.runPromise(
    state.read("test.task-create-count", (reader) =>
      reader.get<{ readonly count: number }>(
        `SELECT COUNT(*) AS count
         FROM work_events
         WHERE item_kind = 'task'
           AND item_id = ?
           AND item_canvas_name = ?
           AND item_node_id = ?
           AND operation = 'task.create'`,
        [taskId, "factory", nodeId],
      )!.count,
    ),
  );

const pendingCommandCount = () =>
  runtime.runPromise(
    state.read("test.pending-command-count", (reader) =>
      reader.get<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM work_pending_commands`,
      )!.count,
    ),
  );

describe("WorkRepository transaction hardening", () => {
  it("requires an exact intent-bound dependency witness and never widens to the canvas", async () => {
    const nodeId = "tasks-scope";
    const prerequisiteNodeId = "tasks-scope-prerequisite";
    const prerequisite = task("scope-a");
    const dependent = task("scope-b", { dependsOn: [prerequisite.id] });
    await createTask(prerequisiteNodeId, prerequisite);

    await expect(createTask(nodeId, dependent)).rejects.toThrow(
      /server-derived scope witness/,
    );
    await expect(
      createTask(
        nodeId,
        dependent,
        scope(nodeId, [], { allowedTaskSinkNodeIds: [] }),
      ),
    ).rejects.toThrow(/references missing task/);
    await expect(
      createTask(
        nodeId,
        dependent,
        scope(nodeId, [nodeId, prerequisiteNodeId], {
          nodeId: "different-sink",
        }),
      ),
    ).rejects.toThrow(/exact intent basis and sink/);

    const created = await createTask(
      nodeId,
      dependent,
      scope(nodeId, [nodeId, prerequisiteNodeId]),
    );
    expect(created.value.dependsOn).toEqual([prerequisite.id]);

    const spaced = task("scope-spaced", { dependsOn: [` ${prerequisite.id}`] });
    await expect(
      createTask(
        nodeId,
        spaced,
        scope(nodeId, [nodeId, prerequisiteNodeId]),
      ),
    ).rejects.toThrow(/not canonical/);
  });

  it("rechecks durable admission and hold before local claim or remote reservation", async () => {
    const nodeId = "tasks-claim-gates";
    const raiser = actor("1");
    const gated = task("claim-gated", {
      admission: "operator-gated",
      raisedBy: raiser,
    });
    const held = task("claim-held", {
      admission: "auto",
      holdUntil: "2999-01-01T00:00:00.000Z",
      raisedBy: raiser,
    });
    await createTask(nodeId, gated);
    await createTask(nodeId, held);
    const beforePending = await pendingCommandCount();

    await expect(
      runtime.runPromise(
        repository.claimLocalTask({
          sink: sink(nodeId),
          basis,
          taskId: gated.id,
          actor: actor("2"),
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/awaits operator approval/);
    await expect(
      runtime.runPromise(
        repository.reserveRemoteTaskClaim({
          sink: sink(nodeId),
          taskId: gated.id,
          actor: actor("3"),
          targetInstallationId: remoteInstallationId,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/awaits operator approval/);
    await expect(
      runtime.runPromise(
        repository.claimLocalTask({
          sink: sink(nodeId),
          basis,
          taskId: held.id,
          actor: actor("4"),
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/not assignable before/);
    await expect(
      runtime.runPromise(
        repository.reserveRemoteTaskClaim({
          sink: sink(nodeId),
          taskId: held.id,
          actor: actor("5"),
          targetInstallationId: remoteInstallationId,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/not assignable before/);

    expect(await taskAt(nodeId, gated.id)).toEqual(gated);
    expect(await taskAt(nodeId, held.id)).toEqual(held);
    expect(await pendingCommandCount()).toBe(beforePending);
  });

  it("atomically creates the exact unadmitted Task once and preserves immutable claims", async () => {
    const nodeId = "tasks-legacy-created";
    const prerequisite = task("legacy-prerequisite");
    await createTask(nodeId, prerequisite);
    const source = proposal("legacy-created", actor("6"), {
      dependsOn: [prerequisite.id],
    });
    const dependencyScope = scope(nodeId, [nodeId]);
    await createProposal(nodeId, source, dependencyScope);
    const materialization = materializePendingProposal({ proposal: source });

    const created = await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(nodeId),
        basis,
        dependencyScope,
        materialization,
      }),
    );
    expect(created.status).toBe("created");
    expect(await taskAt(nodeId, source.id)).toEqual(materialization.task);
    expect(await taskCreateCount(nodeId, source.id)).toBe(1);

    const replay = await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(nodeId),
        basis,
        dependencyScope,
        materialization,
      }),
    );
    expect(replay).toEqual({
      status: "already-materialized",
      taskId: source.id,
    });
    expect(await taskCreateCount(nodeId, source.id)).toBe(1);
  });

  it("returns no-longer-pending when rejection wins after the runner precheck", async () => {
    const nodeId = "tasks-legacy-rejected";
    const source = proposal("legacy-rejected", actor("7"));
    await createProposal(nodeId, source);
    const materialization = materializePendingProposal({ proposal: source });
    const createFactBefore = await runtime.runPromise(
      state.read("test.proposal-create-before", (reader) =>
        reader.get<{ readonly record_json: string }>(
          `SELECT record_json
           FROM work_proposal_events
           WHERE canvas_name = ? AND node_id = ? AND proposal_id = ?
             AND operation = 'proposal.create' AND record_type = 'fact'`,
          ["factory", nodeId, source.id],
        )!.record_json,
      ),
    );

    await runtime.runPromise(
      repository.rejectProposal({
        sink: sink(nodeId),
        basis,
        proposalId: source.id,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const result = await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(nodeId),
        basis,
        materialization,
      }),
    );

    expect(result).toEqual({
      status: "no-longer-pending",
      proposalId: source.id,
      proposalState: "rejected",
    });
    expect(await taskAt(nodeId, source.id)).toBeUndefined();
    expect(await taskCreateCount(nodeId, source.id)).toBe(0);
    const createFactAfter = await runtime.runPromise(
      state.read("test.proposal-create-after", (reader) =>
        reader.get<{ readonly record_json: string }>(
          `SELECT record_json
           FROM work_proposal_events
           WHERE canvas_name = ? AND node_id = ? AND proposal_id = ?
             AND operation = 'proposal.create' AND record_type = 'fact'`,
          ["factory", nodeId, source.id],
        )!.record_json,
      ),
    );
    expect(createFactAfter).toBe(createFactBefore);
  });

  it("returns typed invalid for field drift and already-materialized for the same-id race", async () => {
    const invalidNodeId = "tasks-legacy-invalid";
    const invalidSource = proposal("legacy-invalid", actor("8"));
    await createProposal(invalidNodeId, invalidSource);
    const exact = materializePendingProposal({ proposal: invalidSource });
    const staleResult = await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(invalidNodeId),
        basis: staleBasis,
        materialization: exact,
      }),
    );
    expect(staleResult).toMatchObject({
      status: "invalid",
      proposalId: invalidSource.id,
    });

    const schemaInvalid = {
      ...exact,
      task: { ...exact.task, state: "working" },
    } as typeof exact;
    const schemaResult = await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(invalidNodeId),
        basis,
        materialization: schemaInvalid,
      }),
    );
    expect(schemaResult).toMatchObject({
      status: "invalid",
      proposalId: invalidSource.id,
    });

    const drifted = {
      ...exact,
      task: {
        ...exact.task,
        reason: "changed after scan",
      },
    };
    const invalid = await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(invalidNodeId),
        basis,
        materialization: drifted,
      }),
    );
    expect(invalid.status).toBe("invalid");
    expect(await taskAt(invalidNodeId, invalidSource.id)).toBeUndefined();
    expect(await taskCreateCount(invalidNodeId, invalidSource.id)).toBe(0);

    const racedNodeId = "tasks-legacy-raced";
    const racedSource = proposal("legacy-raced", actor("9"));
    await createProposal(racedNodeId, racedSource);
    const racedMaterialization = materializePendingProposal({
      proposal: racedSource,
    });
    await createTask(racedNodeId, racedMaterialization.task);
    const raced = await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(racedNodeId),
        basis,
        materialization: racedMaterialization,
      }),
    );
    expect(raced).toEqual({
      status: "already-materialized",
      taskId: racedSource.id,
    });
    expect(await taskCreateCount(racedNodeId, racedSource.id)).toBe(1);
  });

  it("refuses legacy materialization when the local Work authority is Remote", async () => {
    const nodeId = "tasks-legacy-remote-refusal";
    const source = proposal("legacy-remote-refusal", actor("a"));
    await createProposal(nodeId, source);
    const materialization = materializePendingProposal({ proposal: source });

    await runtime.runPromise(
      state.transaction("test.configure-remote", (writer) => {
        writer.run(
          `UPDATE station_configuration
           SET role = 'remote',
               agent_host_id = 'remote-host',
               command_center_installation_id = ?
           WHERE singleton = 1`,
          [remoteInstallationId],
        );
      }),
    );
    try {
      const result = await runtime.runPromise(
        repository.persistUnadmittedTask({
          sink: sink(nodeId),
          basis,
          materialization,
        }),
      );
      expect(result).toMatchObject({ status: "invalid" });
      expect(await taskAt(nodeId, source.id)).toBeUndefined();
      expect(await taskCreateCount(nodeId, source.id)).toBe(0);
    } finally {
      await runtime.runPromise(
        state.transaction("test.restore-command-center", (writer) => {
          writer.run(
            `UPDATE station_configuration
             SET role = 'command-center',
                 agent_host_id = NULL,
                 command_center_installation_id = NULL
             WHERE singleton = 1`,
          );
        }),
      );
    }
  });
});
