import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorkRepository,
  WorkRepositoryLive,
  createAuthorialTaskDependencyScopeCapability,
  type TaskDependencyScopeCapability,
} from "../src/main/junto/work/repository";
import { subjectHashOf } from "../src/main/junto/work/review-subject-hash";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import type { Task } from "../src/shared/work-model";
import { IntentFactBasis } from "../src/shared/work-protocol";
import type { ActorRef } from "../src/shared/work-reference";
import {
  authorialMaterialForTest,
  authorialTaskTopologyCapabilityForTest,
} from "./helpers/task-topology-authority";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";

const root = join(
  tmpdir(),
  `junto-work-transaction-hardening-${randomUUID()}`,
);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "junto.db")),
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
const taskSinkNodeIds = [
  "tasks-scope",
  "tasks-scope-prerequisite",
  "tasks-claim-gates",
  "tasks-legacy-created",
  "tasks-empty-dependencies",
  "tasks-legacy-rejected",
  "tasks-legacy-invalid",
  "tasks-legacy-raced",
  "tasks-legacy-remote-refusal",
  "tasks-approval-exact",
  "tasks-ancestry-budget",
  "tasks-reservation-race",
  "tasks-floor-gated",
  "tasks-floor-owned",
  "tasks-invalid-hold",
  "tasks-notify",
  "tasks-hash-mismatch",
  "tasks-task-hash-mismatch",
  "tasks-missing-variant",
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
            ? { contract: { incoming: { admission: "approval" as const } } }
            : id === "tasks-floor-owned"
              ? { contract: { incoming: { admission: "operator" as const } } }
              : {}),
        },
      },
    })),
  ],
  edges: [],
};
const canvasBody = serializeCanvas(topology);
const authorityMaterial = authorialMaterialForTest({
  generation: "1",
  documents: new Map([
    ["factory", { document: topology, rawBody: canvasBody }],
  ]),
});
const intentSha256 = authorityMaterial.intentSha256;
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
  contentSha256: intentSha256,
});

const actor = (digit: string, nodeId = `worker-${digit}`): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`),
  canvasName: "factory",
  nodeId,
});

const scope = (
  nodeId: string,
  basisValue = basis,
): TaskDependencyScopeCapability =>
  authorialTaskTopologyCapabilityForTest({
    basis: basisValue,
    sink: { canvasName: "factory", nodeId },
    document: topology,
    rawBody: canvasBody,
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
    readonly waitUntil?: string;
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
  ...(options?.waitUntil === undefined
    ? {}
    : { waitUntil: options.waitUntil }),
  ...(options?.raisedBy === undefined
    ? {}
    : { raisedBy: options.raisedBy }),
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
    seedCanvasAuthority(writer, {
      generation: "1",
      documents: new Map([["factory", topology]]),
      at: observedAt,
    });
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
  dependencyScope: TaskDependencyScopeCapability = scope(nodeId),
) =>
  runtime.runPromise(
    repository.createTask({
      sink: sink(nodeId),
      basis,
      task: value,
      dependencyScope,
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

const expectTaskProjection = (actual: Task | undefined, nodeId: string, expected: Task): void => {
  expect(actual).toBeDefined();
  const { subjectHash, verdicts, ...persisted } = actual!;
  expect(persisted).toEqual(expected);
  expect(verdicts).toEqual([]);
  expect(subjectHash).toBe(subjectHashOf({
    kind: "task",
    installationId,
    ...sink(nodeId),
    taskId: expected.id,
    epoch: expected.epoch ?? 0,
  }));
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
  it("requires an exact intent-bound dependency witness and detaches authority after mint", async () => {
    const nodeId = "tasks-scope";
    const prerequisiteNodeId = "tasks-scope-prerequisite";
    const prerequisite = task("scope-a");
    const dependent = task("scope-b", { dependsOn: [prerequisite.id] });
    await createTask(prerequisiteNodeId, prerequisite);

    await expect(
      createTask(
        nodeId,
        dependent,
        scope(prerequisiteNodeId),
      ),
    ).rejects.toThrow(/exact canvas and sink/);

    const mutableTopology = structuredClone(topology);
    const mutableAuthority = authorialMaterialForTest({
      generation: basis.generation,
      documents: new Map([
        [
          "factory",
          { document: mutableTopology, rawBody: canvasBody },
        ],
      ]),
    });
    const detachedCapability = createAuthorialTaskDependencyScopeCapability({
      authority: mutableAuthority,
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

  it("requires exact authority for every zero-dependency Task materialization and claim", async () => {
    const nodeId = "tasks-empty-dependencies";
    await expect(
      runtime.runPromise(
        repository.createTask({
          sink: sink(nodeId),
          basis,
          dependencyScope: undefined as never,
          task: task("zero-authority-create"),
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/authentic process-local capability/);

    const claimable = task("zero-authority-claim");
    await createTask(nodeId, claimable);
    await expect(
      runtime.runPromise(
        repository.claimLocalTask({
          sink: sink(nodeId),
          basis,
          dependencyScope: undefined as never,
          taskId: claimable.id,
          actor: actor("e"),
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/authentic process-local capability/);
    await expect(
      runtime.runPromise(
        repository.reserveRemoteTaskClaim({
          sink: sink(nodeId),
          basis,
          dependencyScope: undefined as never,
          taskId: claimable.id,
          actor: actor("d"),
          targetInstallationId: remoteInstallationId,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/authentic process-local capability/);

    await expect(
      createTask(
        nodeId,
        task("zero-authority-structural"),
        Object.freeze(Object.create(null)) as TaskDependencyScopeCapability,
      ),
    ).rejects.toThrow(/authentic process-local capability/);
  });

  it("rechecks durable admission and hold before local claim or remote reservation", async () => {
    const nodeId = "tasks-claim-gates";
    const raiser = actor("1");
    const gated = task("claim-gated", {
      admission: "approval",
      raisedBy: raiser,
    });
    const held = task("claim-held", {
      admission: "auto",
      waitUntil: "2999-01-01T00:00:00.000Z",
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
    ).rejects.toThrow(/not claimable before/);
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
    ).rejects.toThrow(/not claimable before/);

    expectTaskProjection(await taskAt(nodeId, gated.id), nodeId, gated);
    expectTaskProjection(await taskAt(nodeId, held.id), nodeId, held);
    expect(await pendingCommandCount()).toBe(beforePending);
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
    expectTaskProjection(await taskAt(nodeId, value.id), nodeId, value);
  });

  it("enforces inherited board admission floors and canonical finite waits", async () => {
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
        nodeId === "tasks-floor-gated" ? /awaits operator approval/ : /set to Me/,
      );
    }

    const nodeId = "tasks-invalid-hold";
    for (const [index, waitUntil] of [
      "not-an-iso-time",
      "2026-08-26T18:00:00+00:00",
      "+999999-01-01T00:00:00.000Z",
    ].entries()) {
      await expect(
        createTask(
          nodeId,
          task(`invalid-hold-${index}`, { admission: "auto", waitUntil }),
        ),
      ).rejects.toThrow(/noncanonical waitUntil/);
    }
  });

  it("does not let stateful authority material downgrade the stored admission floor", async () => {
    const nodeId = "tasks-floor-owned";
    const value = task("floor-stateful-substitution", { admission: "auto" });
    await createTask(nodeId, value);

    const loweredTopology = structuredClone(topology);
    const loweredNode = loweredTopology.nodes.find((node) => node.id === nodeId);
    if (
      loweredNode === undefined ||
      loweredNode.type === "group" ||
      loweredNode.ether?.tasks?.contract === undefined
    ) {
      throw new Error("floor substitution fixture lost its Task contract");
    }
    (loweredNode.ether.tasks.contract.incoming as {
      admission: "auto" | "approval" | "operator";
    }).admission = "auto";
    const deceptiveDocuments = new Map(authorityMaterial.documents);
    const ordinaryGet = deceptiveDocuments.get.bind(deceptiveDocuments);
    Object.defineProperty(deceptiveDocuments, "get", {
      value: (name: string) =>
        name === "factory" ? loweredTopology : ordinaryGet(name),
    });
    const capability = createAuthorialTaskDependencyScopeCapability({
      authority: { ...authorityMaterial, documents: deceptiveDocuments },
      authoringSink: sink(nodeId),
    });

    await expect(
      runtime.runPromise(
        repository.claimLocalTask({
          sink: sink(nodeId),
          basis,
          dependencyScope: capability,
          taskId: value.id,
          actor: actor("d"),
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/set to Me/);
  });

  it("rejects empty and over-limit dependencies and over-limit topology scope", async () => {
    const nodeId = "tasks-bounds";
    await expect(
      createTask(
        nodeId,
        task("empty-dependency", { dependsOn: [""] }),
        scope(nodeId),
      ),
    ).rejects.toThrow(/non-empty task ids/);

    await expect(
      createTask(
        nodeId,
        task(
          "too-many-dependencies",
          {
            dependsOn: Array.from(
              { length: 257 },
              (_, index) => `dep-${index}`,
            ),
          },
        ),
        scope(nodeId),
      ),
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
    const oversizedRawBody = JSON.stringify(oversizedTopology);
    const oversizedAuthority = authorialMaterialForTest({
      generation: "99",
      documents: new Map([
        [
          "factory",
          { document: oversizedTopology, rawBody: oversizedRawBody },
        ],
      ]),
    });
    expect(() =>
      createAuthorialTaskDependencyScopeCapability({
        authority: oversizedAuthority,
        authoringSink: {
          canvasName: "factory",
          nodeId: "bounded-task-0",
        },
      }),
    ).toThrow(/maximum is 256/);
  });

  it("rejects altered bytes, ambiguous regions, duplicate graph identities, dangling edges, and invalid sinks", () => {
    const taskNode = {
      id: "authority-task",
      type: "text" as const,
      x: 160,
      y: 60,
      width: 80,
      height: 60,
      text: "Task",
      ether: { entity: { kind: "task" } },
    };
    const otherTaskNode = { ...taskNode, id: "authority-task-other", x: 260 };
    const group = (
      id: string,
      x: number,
      width: number,
    ): CanvasDoc["nodes"][number] => ({
      id,
      type: "group",
      x,
      y: 0,
      width,
      height: 180,
      label: id,
    });
    const candidates: ReadonlyArray<{
      readonly document: CanvasDoc;
      readonly message: RegExp;
    }> = [
      {
        document: {
          nodes: [group("equal-a", 0, 500), group("equal-b", 0, 500), taskNode],
          edges: [],
        },
        message: /ambiguous regions/,
      },
      {
        document: {
          nodes: [group("overlap-a", 0, 360), group("overlap-b", 100, 360), taskNode],
          edges: [],
        },
        message: /ambiguous regions/,
      },
      {
        document: {
          nodes: [taskNode, { ...taskNode }],
          edges: [],
        },
        message: /duplicate node id/,
      },
      {
        document: {
          nodes: [group("duplicate-group", 0, 500), group("duplicate-group", 0, 500), taskNode],
          edges: [],
        },
        message: /duplicate node id/,
      },
      {
        document: {
          nodes: [taskNode, otherTaskNode],
          edges: [
            {
              id: "duplicate-edge",
              fromNode: taskNode.id,
              toNode: otherTaskNode.id,
              ether: { verb: "feeds" },
            },
            {
              id: "duplicate-edge",
              fromNode: taskNode.id,
              toNode: otherTaskNode.id,
              ether: { verb: "feeds" },
            },
          ],
        },
        message: /duplicate edge id/,
      },
      {
        document: {
          nodes: [taskNode],
          edges: [{
            id: "dangling",
            fromNode: taskNode.id,
            toNode: "missing",
          }],
        },
        message: /dangling endpoint/,
      },
    ];
    for (const [index, candidate] of candidates.entries()) {
      const rawBody = JSON.stringify(candidate.document);
      const authority = authorialMaterialForTest({
        generation: String(200 + index),
        documents: new Map([
          ["factory", { document: candidate.document, rawBody }],
        ]),
      });
      expect(() =>
        createAuthorialTaskDependencyScopeCapability({
          authority,
          authoringSink: {
            canvasName: "factory",
            nodeId: taskNode.id,
          },
        }),
      ).toThrow(candidate.message);
    }

    const invalidSinkDocument: CanvasDoc = {
      nodes: [
        taskNode,
        {
          id: "authority-page",
          type: "text",
          x: 300,
          y: 60,
          width: 80,
          height: 60,
          text: "Page",
          ether: { entity: { kind: "page" } },
        },
      ],
      edges: [],
    };
    const invalidSinkRawBody = JSON.stringify(invalidSinkDocument);
    const invalidSinkAuthority = authorialMaterialForTest({
      generation: "300",
      documents: new Map([
        [
          "factory",
          { document: invalidSinkDocument, rawBody: invalidSinkRawBody },
        ],
      ]),
    });
    for (const nodeId of ["missing-task", "authority-page"]) {
      expect(() =>
        createAuthorialTaskDependencyScopeCapability({
          authority: invalidSinkAuthority,
          authoringSink: { canvasName: "factory", nodeId },
        }),
      ).toThrow(/missing or is not an actual Task sink/);
    }

    const exactDocument: CanvasDoc = { nodes: [taskNode], edges: [] };
    const exactRawBody = JSON.stringify(exactDocument);
    const exactAuthority = authorialMaterialForTest({
      generation: "301",
      documents: new Map([
        ["factory", { document: exactDocument, rawBody: exactRawBody }],
      ]),
    });
    const exactStored = exactAuthority.storedDocuments.get("factory")!;
    expect(() =>
      createAuthorialTaskDependencyScopeCapability({
        authority: {
          ...exactAuthority,
          storedDocuments: new Map([
            ["factory", { ...exactStored, rawBody: `${exactRawBody} ` }],
          ]),
        },
        authoringSink: { canvasName: "factory", nodeId: taskNode.id },
      }),
    ).toThrow(/raw body hash mismatch/);

    const alteredDocument: CanvasDoc = {
      nodes: [{ ...taskNode, x: taskNode.x + 1 }],
      edges: [],
    };
    const semanticMismatch = authorialMaterialForTest({
      generation: "302",
      documents: new Map([
        ["factory", { document: alteredDocument, rawBody: exactRawBody }],
      ]),
    });
    expect(() =>
      createAuthorialTaskDependencyScopeCapability({
        authority: semanticMismatch,
        authoringSink: { canvasName: "factory", nodeId: taskNode.id },
      }),
    ).toThrow(/semantic document mismatch/);
  });
});
