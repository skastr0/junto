import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorkRepository,
  WorkRepositoryLive,
  createTaskDependencyScopeCapability,
  type TaskDependencyScopeCapability,
} from "../src/main/vellum/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import { materializePendingProposal } from "../src/shared/pending-proposal-backfill";
import type { CanvasDoc } from "../src/shared/canvas";
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
const taskSinkNodeIds = [
  "tasks-scope",
  "tasks-scope-prerequisite",
  "tasks-claim-gates",
  "tasks-legacy-created",
  "tasks-legacy-rejected",
  "tasks-legacy-invalid",
  "tasks-legacy-raced",
  "tasks-legacy-remote-refusal",
  "tasks-approval-exact",
  "tasks-reservation-race",
  "tasks-floor-gated",
  "tasks-floor-owned",
  "tasks-invalid-hold",
  "tasks-notify",
  "tasks-hash-mismatch",
  "tasks-task-hash-mismatch",
  "tasks-bounds",
] as const;
const topology: CanvasDoc = {
  nodes: [
    {
      id: "region",
      type: "group",
      x: 0,
      y: 0,
      width: 4_000,
      height: 4_000,
      label: "Repository hardening",
    },
    ...taskSinkNodeIds.map((id, index) => ({
      id,
      type: "text" as const,
      text: id,
      x: 20 + index * 300,
      y: 20,
      width: 220,
      height: 100,
      ether: {
        entity: { kind: "task" },
        tasks: {
          items: [],
          ...(id === "tasks-floor-gated"
            ? { contract: { inbound: { admission: "operator-gated" as const } } }
            : id === "tasks-floor-owned"
              ? { contract: { inbound: { admission: "operator-owned" as const } } }
              : {}),
        },
      },
    })),
  ],
  edges: [],
};
const canvasBody = JSON.stringify(topology);

const actor = (digit: string, nodeId = `worker-${digit}`): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`),
  canvasName: "factory",
  nodeId,
});

const scope = (
  nodeId: string,
  basisValue = basis,
): TaskDependencyScopeCapability =>
  createTaskDependencyScopeCapability({
    topology,
    basis: basisValue,
    authoringSink: { canvasName: "factory", nodeId },
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
  dependencyScope?: TaskDependencyScopeCapability,
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
  dependencyScope?: TaskDependencyScopeCapability,
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
      /authentic process-local scope capability/,
    );
    const forged = Object.freeze({}) as TaskDependencyScopeCapability;
    await expect(
      createTask(nodeId, dependent, forged),
    ).rejects.toThrow(/authentic process-local scope capability/);
    await expect(
      createTask(
        nodeId,
        dependent,
        scope(prerequisiteNodeId),
      ),
    ).rejects.toThrow(/exact canvas and sink/);

    const mutableTopology = structuredClone(topology);
    const detachedCapability = createTaskDependencyScopeCapability({
      topology: mutableTopology,
      basis,
      authoringSink: { canvasName: "factory", nodeId },
    });
    expect(Object.isFrozen(detachedCapability)).toBe(true);
    expect(Object.getPrototypeOf(detachedCapability)).toBeNull();
    expect(Reflect.ownKeys(detachedCapability)).toEqual([]);
    // The WeakMap retains only the already-derived authority. Destroying the
    // caller's document after mint cannot narrow, widen, or otherwise alter it.
    (mutableTopology.nodes as Array<CanvasDoc["nodes"][number]>).splice(
      0,
      mutableTopology.nodes.length,
    );
    const created = await createTask(
      nodeId,
      dependent,
      detachedCapability,
    );
    expect(created.value.dependsOn).toEqual([prerequisite.id]);

    const spaced = task("scope-spaced", { dependsOn: [` ${prerequisite.id}`] });
    await expect(
      createTask(
        nodeId,
        spaced,
        scope(nodeId),
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
          dependencyScope: scope(nodeId),
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
          basis,
          dependencyScope: scope(nodeId),
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
          dependencyScope: scope(nodeId),
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
          basis,
          dependencyScope: scope(nodeId),
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
    const dependencyScope = scope(nodeId);
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

    await runtime.runPromise(
      repository.describeTask({
        sink: sink(nodeId),
        basis,
        dependencyScope,
        taskId: source.id,
        message: message("legacy-created-described", "updated brief"),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    const descendantReplay = await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(nodeId),
        basis,
        dependencyScope,
        materialization,
      }),
    );
    expect(descendantReplay).toEqual({
      status: "already-materialized",
      taskId: source.id,
    });
    expect((await taskAt(nodeId, source.id))?.history[0]?.messageId).toBe(
      "message-legacy-created-described",
    );
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
    let noLongerNotifications = 0;
    const stop = repository.subscribeChanges((canvasName, changedNodeId) => {
      if (canvasName === "factory" && changedNodeId === nodeId) {
        noLongerNotifications += 1;
      }
    });
    const result = await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(nodeId),
        basis,
        materialization,
      }),
    );
    stop();

    expect(noLongerNotifications).toBe(0);
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

  it("returns typed invalid for field drift and an unrelated same-id collision", async () => {
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
    const racedMaterialization = materializePendingProposal({
      proposal: racedSource,
    });
    // An unrelated create that wins the Task id before the proposal is not a
    // backfill replay, even when its bytes happen to match reconstruction.
    await createTask(racedNodeId, racedMaterialization.task);
    await createProposal(racedNodeId, racedSource);
    const raced = await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(racedNodeId),
        basis,
        materialization: racedMaterialization,
      }),
    );
    expect(raced).toMatchObject({ status: "invalid" });
    expect(await taskCreateCount(racedNodeId, racedSource.id)).toBe(1);
  });

  it("requires the immutable proposal witness and exact stable Task on local approval", async () => {
    const nodeId = "tasks-approval-exact";
    const prerequisite = task("approval-prerequisite");
    await createTask(nodeId, prerequisite);
    const source: TaskProposal = {
      ...proposal("approval-exact", actor("b"), {
        dependsOn: [prerequisite.id],
      }),
      brief: {
        messageId: "message-approval-exact",
        role: "user",
        parts: [
          { kind: "text", text: "preserve exact media" },
          {
            kind: "url",
            url: "https://example.com/evidence.png",
            mediaType: "image/png",
          },
          { kind: "data", data: { nested: ["exact"] } },
        ],
        taskId: "historical-proposal-task-ref",
        contextId: "factory-context",
        referenceTaskIds: [prerequisite.id],
        metadata: { channel: "planning" },
      },
      metadata: {
        title: "Exact approval",
        details: "Every authoring field survives",
        nested: { value: 1 },
      },
      reason: "operator review",
    };
    await createProposal(nodeId, source, scope(nodeId));
    const exact = materializePendingProposal({ proposal: source }).task;
    const variants: ReadonlyArray<Task> = [
      { ...exact, id: `${exact.id}-different` },
      {
        ...exact,
        history: [
          {
            ...exact.history[0]!,
            parts: [{ kind: "text", text: "changed" }],
          },
        ],
      },
      { ...exact, metadata: { changed: true } },
      { ...exact, reason: "changed" },
      { ...exact, dependsOn: [] },
      { ...exact, finishCriteria: { description: "changed" } },
      { ...exact, claims: [] },
      { ...exact, admission: "auto" },
      { ...exact, raisedBy: actor("c") },
      { ...exact, artifactIds: [] },
      { ...exact, epoch: 0 },
      { ...exact, journey: [] },
      { ...exact, defects: [] },
      { ...exact, holdUntil: "2999-01-01T00:00:00.000Z" },
      { ...exact, boarding: [] },
      { ...exact, response: "prestamped" },
    ];
    let notifications = 0;
    const stop = repository.subscribeChanges((canvasName, changedNodeId) => {
      if (canvasName === "factory" && changedNodeId === nodeId) {
        notifications += 1;
      }
    });
    try {
      for (const drifted of variants) {
        await expect(
          runtime.runPromise(
            repository.approveProposal({
              sink: sink(nodeId),
              basis,
              dependencyScope: scope(nodeId),
              proposalId: source.id,
              task: drifted,
              originAt: observedAt,
              receivedAt: observedAt,
            }),
          ),
        ).rejects.toThrow(/exact stable Task identity|current Task schema/);
      }
      expect(notifications).toBe(0);
      expect(await taskAt(nodeId, source.id)).toBeUndefined();

      const approved = await runtime.runPromise(
        repository.approveProposal({
          sink: sink(nodeId),
          basis,
          dependencyScope: scope(nodeId),
          proposalId: source.id,
          task: exact,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
      expect(approved.value.task).toEqual(exact);
      expect(approved.value.proposal).toEqual({
        ...source,
        state: "approved",
        approvedTaskId: source.id,
      });
      expect(notifications).toBe(1);
    } finally {
      stop();
    }
  });

  it("serializes Remote reservation against duplicate reserve and local claim", async () => {
    const nodeId = "tasks-reservation-race";
    const value = task("reservation-race", { admission: "auto" });
    await createTask(nodeId, value);
    const before = await pendingCommandCount();
    const first = await runtime.runPromise(
      repository.reserveRemoteTaskClaim({
        sink: sink(nodeId),
        basis,
        dependencyScope: scope(nodeId),
        taskId: value.id,
        actor: actor("d"),
        targetInstallationId: remoteInstallationId,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(first.body.operation).toBe("task.claim");
    for (const contender of [actor("d"), actor("e")]) {
      await expect(
        runtime.runPromise(
          repository.reserveRemoteTaskClaim({
            sink: sink(nodeId),
            basis,
            dependencyScope: scope(nodeId),
            taskId: value.id,
            actor: contender,
            targetInstallationId: remoteInstallationId,
            originAt: observedAt,
            receivedAt: observedAt,
          }),
        ),
      ).rejects.toThrow(/unresolved Remote claim reservation/);
    }
    await expect(
      runtime.runPromise(
        repository.claimLocalTask({
          sink: sink(nodeId),
          basis,
          dependencyScope: scope(nodeId),
          taskId: value.id,
          actor: actor("f"),
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/unresolved Remote claim reservation/);
    expect(await pendingCommandCount()).toBe(before + 1);
    expect(await taskAt(nodeId, value.id)).toEqual(value);
  });

  it("enforces inherited sink admission floors and canonical finite holds", async () => {
    for (const nodeId of ["tasks-floor-gated", "tasks-floor-owned"] as const) {
      const value = task(`floor-${nodeId}`, { admission: "auto" });
      await createTask(nodeId, value);
      await expect(
        runtime.runPromise(
          repository.claimLocalTask({
            sink: sink(nodeId),
            basis,
            dependencyScope: scope(nodeId),
            taskId: value.id,
            actor: actor(nodeId === "tasks-floor-gated" ? "1" : "2"),
            originAt: observedAt,
            receivedAt: observedAt,
          }),
        ),
      ).rejects.toThrow(
        nodeId === "tasks-floor-gated" ? /awaits operator approval/ : /operator-owned/,
      );
    }

    const nodeId = "tasks-invalid-hold";
    for (const [index, holdUntil] of [
      "not-an-iso-time",
      "2026-08-26T18:00:00+00:00",
      "+999999-01-01T00:00:00.000Z",
    ].entries()) {
      await expect(
        createTask(
          nodeId,
          task(`invalid-hold-${index}`, { admission: "auto", holdUntil }),
        ),
      ).rejects.toThrow(/noncanonical holdUntil/);
    }
  });

  it("notifies only after a committed material change", async () => {
    const nodeId = "tasks-notify";
    const source = proposal("notify-noops", actor("3"));
    await createProposal(nodeId, source);
    const materialization = materializePendingProposal({ proposal: source });
    let notifications = 0;
    const stop = repository.subscribeChanges((canvasName, changedNodeId) => {
      if (canvasName === "factory" && changedNodeId === nodeId) {
        notifications += 1;
      }
    });
    try {
      const invalid = await runtime.runPromise(
        repository.persistUnadmittedTask({
          sink: sink(nodeId),
          basis,
          materialization: {
            ...materialization,
            task: { ...materialization.task, reason: "drift" },
          },
        }),
      );
      expect(invalid.status).toBe("invalid");
      expect(notifications).toBe(0);

      const created = await runtime.runPromise(
        repository.persistUnadmittedTask({
          sink: sink(nodeId),
          basis,
          materialization,
        }),
      );
      expect(created.status).toBe("created");
      expect(notifications).toBe(1);

      const replay = await runtime.runPromise(
        repository.persistUnadmittedTask({
          sink: sink(nodeId),
          basis,
          materialization,
        }),
      );
      expect(replay.status).toBe("already-materialized");
      expect(notifications).toBe(1);
    } finally {
      stop();
    }
  });

  it("rejects immutable stored/declared/recomputed hash mismatches", async () => {
    const proposalNodeId = "tasks-hash-mismatch";
    const source = proposal("proposal-hash-mismatch", actor("4"));
    await createProposal(proposalNodeId, source);
    await runtime.runPromise(
      state.transaction("test.corrupt-proposal-hash", (writer) => {
        writer.run("DROP TRIGGER work_proposal_events_immutable_update");
        writer.run(
          `UPDATE work_proposal_events
           SET content_sha256 = ?
           WHERE canvas_name = ? AND node_id = ? AND proposal_id = ?
             AND record_type = 'fact' AND operation = 'proposal.create'`,
          ["f".repeat(64), "factory", proposalNodeId, source.id],
        );
        writer.run(
          `CREATE TRIGGER work_proposal_events_immutable_update
           BEFORE UPDATE ON work_proposal_events
           BEGIN SELECT RAISE(ABORT, 'work records are immutable'); END`,
        );
      }),
    );
    const invalidProposal = await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(proposalNodeId),
        basis,
        materialization: materializePendingProposal({ proposal: source }),
      }),
    );
    expect(invalidProposal).toMatchObject({ status: "invalid" });

    const taskNodeId = "tasks-task-hash-mismatch";
    const taskSource = proposal("task-hash-mismatch", actor("5"));
    await createProposal(taskNodeId, taskSource);
    const taskMaterialization = materializePendingProposal({ proposal: taskSource });
    await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(taskNodeId),
        basis,
        materialization: taskMaterialization,
      }),
    );
    await runtime.runPromise(
      state.transaction("test.corrupt-task-hash", (writer) => {
        writer.run("DROP TRIGGER work_events_immutable_update");
        writer.run(
          `UPDATE work_events
           SET content_sha256 = ?
           WHERE item_canvas_name = ? AND item_node_id = ? AND item_id = ?
             AND record_type = 'fact' AND operation = 'task.create'`,
          ["e".repeat(64), "factory", taskNodeId, taskSource.id],
        );
        writer.run(
          `CREATE TRIGGER work_events_immutable_update
           BEFORE UPDATE ON work_events
           BEGIN SELECT RAISE(ABORT, 'work records are immutable'); END`,
        );
      }),
    );
    const invalidTask = await runtime.runPromise(
      repository.persistUnadmittedTask({
        sink: sink(taskNodeId),
        basis,
        materialization: taskMaterialization,
      }),
    );
    expect(invalidTask).toMatchObject({ status: "invalid" });
  });

  it("rejects empty and over-limit dependencies and over-limit topology scope", async () => {
    const nodeId = "tasks-bounds";
    await expect(
      createProposal(nodeId, {
        ...proposal("empty-dependency", actor("6")),
        dependsOn: [""],
      }, scope(nodeId)),
    ).rejects.toThrow(/non-empty canonical Task ids/);

    await expect(
      createProposal(nodeId, {
        ...proposal("too-many-dependencies", actor("7")),
        dependsOn: Array.from({ length: 257 }, (_, index) => `dep-${index}`),
      }, scope(nodeId)),
    ).rejects.toThrow(/maximum is 256/);

    const oversizedTopology: CanvasDoc = {
      nodes: Array.from({ length: 257 }, (_, index) => ({
        id: `bounded-task-${index}`,
        type: "text" as const,
        text: `bounded task ${index}`,
        x: index * 240,
        y: 0,
        width: 220,
        height: 100,
        ether: { entity: { kind: "task" }, tasks: { items: [] } },
      })),
      edges: [],
    };
    expect(() =>
      createTaskDependencyScopeCapability({
        topology: oversizedTopology,
        basis,
        authoringSink: {
          canvasName: "factory",
          nodeId: "bounded-task-0",
        },
      }),
    ).toThrow(/maximum is 256/);
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
