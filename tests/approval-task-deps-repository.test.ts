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
} from "../src/main/vellum/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import { ActorSeatId } from "../src/shared/actor-seat";
import { CanvasDoc, serializeCanvas } from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import { taskDepStatus, taskIsClaimReady } from "../src/shared/task-deps";
import type { Task } from "../src/shared/work-model";
import { IntentFactBasis } from "../src/shared/work-protocol";
import type { ActorRef } from "../src/shared/work-reference";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";
import { authorialMaterialForTest } from "./helpers/task-topology-authority";

const root = join(
  tmpdir(),
  `vellum-command-approval-task-deps-${randomUUID()}`,
);
const runtime = ManagedRuntime.make(
  Layer.provideMerge(
    WorkRepositoryLive,
    makeStateEngineLive(join(root, "vellum-command.db")),
  ),
);

let repository: Context.Service.Shape<typeof WorkRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const observedAt = "2026-08-26T14:00:00.000Z";
const installationId = Schema.decodeUnknownSync(InstallationId)(
  "cc-approval-task-deps",
);

type TestSink = {
  readonly canvasName: string;
  readonly nodeId: string;
};

const taskSinkNode = (nodeId: string, x = 0, y = 40) => ({
  id: nodeId,
  type: "text" as const,
  x,
  y,
  width: 180,
  height: 80,
  text: nodeId,
  ether: { entity: { kind: "task", name: nodeId } },
});

const authorityTopology = Schema.decodeUnknownSync(CanvasDoc, {
  onExcessProperty: "error",
})({
  nodes: [
    {
      id: "region-scope-together",
      type: "group",
      x: 0,
      y: 0,
      width: 500,
      height: 180,
      label: "Scope together",
    },
    {
      id: "region-scope-cross",
      type: "group",
      x: 600,
      y: 0,
      width: 220,
      height: 180,
      label: "Scope cross",
    },
    taskSinkNode("tasks-scope-prerequisite", 20),
    taskSinkNode("tasks-scope-same-region", 260),
    taskSinkNode("tasks-scope-cross-region", 620),
    {
      id: "region-remote-together",
      type: "group",
      x: 0,
      y: 300,
      width: 500,
      height: 180,
      label: "Remote together",
    },
    {
      id: "region-remote-cross",
      type: "group",
      x: 600,
      y: 300,
      width: 220,
      height: 180,
      label: "Remote cross",
    },
    taskSinkNode("tasks-remote-prerequisite", 20, 340),
    taskSinkNode("tasks-remote-same-region", 260, 340),
    taskSinkNode("tasks-remote-cross-region", 620, 340),
    taskSinkNode("tasks-a-first", 1_000, 40),
    taskSinkNode("tasks-b-first", 1_220, 40),
    taskSinkNode("tasks-rejected", 1_440, 40),
  ],
  edges: [],
});
const authorityRawBody = serializeCanvas(authorityTopology);
const authorityMaterial = authorialMaterialForTest({
  generation: "1",
  documents: new Map([
    [
      "factory",
      { document: authorityTopology, rawBody: authorityRawBody },
    ],
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

const dependencyScope = (sink: TestSink): TaskDependencyScopeCapability =>
  createAuthorialTaskDependencyScopeCapability({
    authority: authorityMaterial,
    authoringSink: sink,
  });

const seed = () =>
  state.transaction("test.seed", (writer) => {
    writer.run(
      `INSERT INTO station_known_installations(installation_id, registered_at)
       VALUES (?, ?)`,
      [installationId, observedAt],
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
      documents: new Map([["factory", authorityTopology]]),
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

const actor = (digit: string): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${digit.repeat(64)}`),
  canvasName: "factory",
  nodeId: `worker-${digit}`,
});

const task = (
  id: string,
  raisedBy: ActorRef,
  dependsOn?: ReadonlyArray<string>,
): Task => ({
  id,
  state: "submitted",
  history: [
    {
      messageId: `message-${id}`,
      role: "user",
      parts: [{ kind: "text", text: id }],
      taskId: id,
      contextId: "factory",
    },
  ],
  metadata: { details: `${id} details` },
  ...(dependsOn === undefined ? {} : { dependsOn }),
  admission: "approval",
  raisedBy,
});

const taskAt = async (
  sink: { readonly canvasName: string; readonly nodeId: string },
  taskId: string,
): Promise<Task> => {
  const snapshot = await runtime.runPromise(
    repository.readSnapshot(sink.canvasName, sink.nodeId),
  );
  const found = snapshot.tasks.items.find((item) => item.id === taskId);
  if (found === undefined) throw new Error(`task "${taskId}" not found`);
  return found;
};

const persistChain = async (slug: string, raisedBy: ActorRef) => {
  const sink = { canvasName: "factory", nodeId: `tasks-${slug}` };
  const a = task(`task-a-${slug}`, raisedBy);
  const b = task(`task-b-${slug}`, raisedBy, [a.id]);
  await runtime.runPromise(
    repository.createTask({
      sink,
      basis,
      dependencyScope: dependencyScope(sink),
      task: a,
      originAt: observedAt,
      receivedAt: observedAt,
    }),
  );
  await runtime.runPromise(
    repository.createTask({
      sink,
      basis,
      dependencyScope: dependencyScope(sink),
      task: b,
      originAt: observedAt,
      receivedAt: observedAt,
    }),
  );
  return { sink, a, b };
};

describe("approval-admission Task dependency persistence", () => {
  it.each([
    ["A then B", "a-first", "c", ["a", "b"]],
    ["B then A", "b-first", "d", ["b", "a"]],
  ] as const)(
    "keeps stable ids and the durable edge for approval order %s",
    async (_label, slug, actorDigit, approvalOrder) => {
      const worker = actor(actorDigit);
      const chain = await persistChain(slug, worker);

      expect(await taskAt(chain.sink, chain.a.id)).toEqual(chain.a);
      expect(await taskAt(chain.sink, chain.b.id)).toEqual(chain.b);
      const edgesBeforeApproval = await runtime.runPromise(
        state.read("test.dep-before-approval", (reader) =>
          reader.all<{
            readonly task_id: string;
            readonly depends_on_task_id: string;
          }>(
            `SELECT task_id, depends_on_task_id
             FROM work_task_dependencies
             WHERE canvas_name = ? AND node_id = ?
             ORDER BY position`,
            [chain.sink.canvasName, chain.sink.nodeId],
          ),
        ),
      );
      expect(edgesBeforeApproval).toEqual([
        { task_id: chain.b.id, depends_on_task_id: chain.a.id },
      ]);

      for (const member of approvalOrder) {
        const taskId = member === "a" ? chain.a.id : chain.b.id;
        await runtime.runPromise(
          repository.promoteTask({
            sink: chain.sink,
            basis,
            taskId,
            originAt: observedAt,
            receivedAt: observedAt,
          }),
        );
        expect((await taskAt(chain.sink, chain.a.id)).id).toBe(chain.a.id);
        const currentB = await taskAt(chain.sink, chain.b.id);
        expect(currentB.id).toBe(chain.b.id);
        expect(currentB.dependsOn).toEqual([chain.a.id]);
      }

      await expect(
        runtime.runPromise(
          repository.claimLocalTask({
            sink: chain.sink,
            basis,
            dependencyScope: dependencyScope(chain.sink),
            taskId: chain.b.id,
            actor: worker,
            originAt: observedAt,
            receivedAt: observedAt,
          }),
        ),
      ).rejects.toThrow(/unsatisfied dependsOn/);

      await runtime.runPromise(
        repository.claimLocalTask({
          sink: chain.sink,
          basis,
          dependencyScope: dependencyScope(chain.sink),
          taskId: chain.a.id,
          actor: worker,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
      await expect(
        runtime.runPromise(
          repository.claimLocalTask({
            sink: chain.sink,
            basis,
            dependencyScope: dependencyScope(chain.sink),
            taskId: chain.b.id,
            actor: worker,
            originAt: observedAt,
            receivedAt: observedAt,
          }),
        ),
      ).rejects.toThrow(/unsatisfied dependsOn/);

      await runtime.runPromise(
        repository.transitionTask({
          sink: chain.sink,
          basis,
          taskId: chain.a.id,
          state: "completed",
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
      const currentB = await taskAt(chain.sink, chain.b.id);
      expect(taskIsClaimReady(currentB, new Map([
        [chain.a.id, await taskAt(chain.sink, chain.a.id)],
        [chain.b.id, currentB],
      ]))).toBe(true);

      const claimedB = await runtime.runPromise(
        repository.claimLocalTask({
          sink: chain.sink,
          basis,
          dependencyScope: dependencyScope(chain.sink),
          taskId: chain.b.id,
          actor: worker,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
      expect(claimedB.value.id).toBe(chain.b.id);
      expect(claimedB.value.dependsOn).toEqual([chain.a.id]);
      expect(claimedB.value.state).toBe("working");
    },
  );

  it("accepts a same-region capability and refuses a cross-region dependency", async () => {
    const worker = actor("9");
    const prerequisiteSink = {
      canvasName: "factory",
      nodeId: "tasks-scope-prerequisite",
    };
    const sameRegionSink = {
      canvasName: "factory",
      nodeId: "tasks-scope-same-region",
    };
    const crossRegionSink = {
      canvasName: "factory",
      nodeId: "tasks-scope-cross-region",
    };
    const prerequisite = task("task-scope-prerequisite", worker);
    await runtime.runPromise(
      repository.createTask({
        sink: prerequisiteSink,
        basis,
        dependencyScope: dependencyScope(prerequisiteSink),
        task: prerequisite,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const sameRegion = task(
      "task-scope-same-region",
      worker,
      [prerequisite.id],
    );
    await runtime.runPromise(
      repository.createTask({
        sink: sameRegionSink,
        basis,
        dependencyScope: dependencyScope(sameRegionSink),
        task: sameRegion,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(await taskAt(sameRegionSink, sameRegion.id)).toEqual(sameRegion);

    const crossRegion = task(
      "task-scope-cross-region",
      worker,
      [prerequisite.id],
    );
    await expect(
      runtime.runPromise(
        repository.createTask({
          sink: crossRegionSink,
          basis,
          dependencyScope: dependencyScope(crossRegionSink),
          task: crossRegion,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/references missing task/);
  });

  it("does not let stateful authority material substitute the current region scope", async () => {
    const worker = actor("8");
    const prerequisiteSink = {
      canvasName: "factory",
      nodeId: "tasks-scope-prerequisite",
    };
    const dependentSink = {
      canvasName: "factory",
      nodeId: "tasks-scope-cross-region",
    };
    const prerequisite = task("task-stateful-region-prerequisite", worker);
    await runtime.runPromise(
      repository.createTask({
        sink: prerequisiteSink,
        basis,
        dependencyScope: dependencyScope(prerequisiteSink),
        task: prerequisite,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const fabricatedTopology: CanvasDoc = {
      nodes: authorityTopology.nodes.filter((node) => node.type !== "group"),
      edges: authorityTopology.edges,
    };
    const deceptiveDocuments = new Map(authorityMaterial.documents);
    const ordinaryGet = deceptiveDocuments.get.bind(deceptiveDocuments);
    Object.defineProperty(deceptiveDocuments, "get", {
      value: (name: string) =>
        name === "factory" ? fabricatedTopology : ordinaryGet(name),
    });
    const capability = createAuthorialTaskDependencyScopeCapability({
      authority: { ...authorityMaterial, documents: deceptiveDocuments },
      authoringSink: dependentSink,
    });

    await expect(
      runtime.runPromise(
        repository.createTask({
          sink: dependentSink,
          basis,
          dependencyScope: capability,
          task: task(
            "task-stateful-region-dependent",
            worker,
            [prerequisite.id],
          ),
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/references missing task/);
  });

  it("reserves a Remote claim only through the current scoped capability", async () => {
    const prerequisiteSink = {
      canvasName: "factory",
      nodeId: "tasks-remote-prerequisite",
    };
    const sameRegionSink = {
      canvasName: "factory",
      nodeId: "tasks-remote-same-region",
    };
    const crossRegionSink = {
      canvasName: "factory",
      nodeId: "tasks-remote-cross-region",
    };
    const prerequisite = task(
      "task-remote-prerequisite",
      actor("a"),
    );
    const sameRegion = task(
      "task-remote-same-region",
      actor("b"),
      [prerequisite.id],
    );
    for (const [sink, current] of [
      [prerequisiteSink, prerequisite],
      [sameRegionSink, sameRegion],
    ] as const) {
      await runtime.runPromise(
        repository.createTask({
          sink,
          basis,
          dependencyScope: dependencyScope(sink),
          task: current,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
      await runtime.runPromise(
        repository.promoteTask({
          sink,
          basis,
          taskId: current.id,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      );
    }
    await runtime.runPromise(
      repository.claimLocalTask({
        sink: prerequisiteSink,
        basis,
        dependencyScope: dependencyScope(prerequisiteSink),
        taskId: prerequisite.id,
        actor: actor("0"),
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    await runtime.runPromise(
      repository.transitionTask({
        sink: prerequisiteSink,
        basis,
        taskId: prerequisite.id,
        state: "completed",
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const remoteInstallation = Schema.decodeUnknownSync(InstallationId)(
      "remote-approval-task-deps",
    );
    await runtime.runPromise(
      state.transaction("test.seed-remote", (writer) => {
        writer.run(
          `INSERT INTO station_known_installations(
             installation_id, registered_at
           ) VALUES (?, ?)`,
          [remoteInstallation, observedAt],
        );
      }),
    );
    const reserved = await runtime.runPromise(
      repository.reserveRemoteTaskClaim({
        sink: sameRegionSink,
        basis,
        dependencyScope: dependencyScope(sameRegionSink),
        taskId: sameRegion.id,
        actor: actor("1"),
        targetInstallationId: remoteInstallation,
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );
    expect(reserved.body).toMatchObject({
      operation: "task.claim",
      sourceTask: { id: sameRegion.id, dependsOn: [prerequisite.id] },
      targetHome: remoteInstallation,
    });

    await expect(
      runtime.runPromise(
        repository.reserveRemoteTaskClaim({
          sink: sameRegionSink,
          basis,
          dependencyScope: dependencyScope(crossRegionSink),
          taskId: sameRegion.id,
          actor: actor("2"),
          targetInstallationId: remoteInstallation,
          originAt: observedAt,
          receivedAt: observedAt,
        }),
      ),
    ).rejects.toThrow(/exact canvas and sink/);
  });

  it("derives rejection as a broken root and leaves the dependent unchanged", async () => {
    const chain = await persistChain("rejected", actor("f"));
    const before = await taskAt(chain.sink, chain.b.id);

    await runtime.runPromise(
      repository.transitionTask({
        sink: chain.sink,
        basis,
        taskId: chain.a.id,
        state: "rejected",
        originAt: observedAt,
        receivedAt: observedAt,
      }),
    );

    const rejected = await taskAt(chain.sink, chain.a.id);
    const after = await taskAt(chain.sink, chain.b.id);
    expect(after).toEqual(before);
    expect(after.state).toBe("submitted");
    expect(taskDepStatus(after, new Map([
      [rejected.id, rejected],
      [after.id, after],
    ]))).toEqual({ kind: "blocked", roots: [chain.a.id] });
  });
});
