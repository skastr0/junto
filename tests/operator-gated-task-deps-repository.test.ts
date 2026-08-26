import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import { ActorSeatId } from "../src/shared/actor-seat";
import { InstallationId } from "../src/shared/installation-id";
import { taskDepStatus, taskIsClaimReady } from "../src/shared/task-deps";
import type { Task } from "../src/shared/work-model";
import { IntentFactBasis } from "../src/shared/work-protocol";
import type { ActorRef } from "../src/shared/work-reference";

const root = join(
  tmpdir(),
  `vellum-command-gated-task-deps-${randomUUID()}`,
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
  "cc-gated-task-deps",
);
const intentSha256 = "e".repeat(64);
const basis = Schema.decodeUnknownSync(IntentFactBasis, {
  onExcessProperty: "error",
})({
  kind: "authorial-intent",
  generation: "1",
  contentSha256: intentSha256,
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
    writer.run(
      `INSERT INTO canvas_generations(
         generation, created_at, cause, intent_sha256, document_count
       ) VALUES ('1', ?, 'test intent', ?, 1)`,
      [observedAt, intentSha256],
    );
    writer.run(
      `INSERT INTO canvas_generation_documents(
         generation, name, body, sha256, modified_at
       ) VALUES ('1', 'factory', '{}', ?, ?)`,
      ["1".repeat(64), observedAt],
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
  admission: "operator-gated",
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
      task: a,
      originAt: observedAt,
      receivedAt: observedAt,
    }),
  );
  await runtime.runPromise(
    repository.createTask({
      sink,
      basis,
      task: b,
      originAt: observedAt,
      receivedAt: observedAt,
    }),
  );
  return { sink, a, b };
};

describe("operator-gated Task dependency persistence", () => {
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
