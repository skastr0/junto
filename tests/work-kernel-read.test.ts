import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Command } from "../src/shared/model";
import { CanvasFactBasis } from "../src/shared/work-protocol";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { createCanvasTaskDependencyScopeCapability, WorkProjectionReaderLive, WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { readLiveCanvas } from "../src/main/junto/overseer/live/composition";
import { unjournaledWorkMutationEffect } from "../src/main/junto/work/mutation-seam";

it("reads kernel lanes and compact watch counts without decoding mail, board posts or artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-kernel-read-"));
  const modelLive = Layer.provideMerge(Layer.provide(ModelLive, ModelDependents.empty), makeStateEngineLive(join(root, "junto.db")));
  const runtime = ManagedRuntime.make(Layer.provideMerge(Layer.mergeAll(WorkRepositoryLive, WorkProjectionReaderLive), modelLive));
  try {
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO station_known_installations VALUES ('board-home','2026-10-07')`;
      yield* sql`INSERT INTO station_installation VALUES (1,'board-home','2026-10-07')`;
      yield* sql`INSERT INTO station_configuration(singleton,role,host_id,agent_host_id,command_center_installation_id,supervised_preferred,configured_at) VALUES (1,'command-center','local',NULL,NULL,1,'2026-10-07')`;
    })));
    const model = await runtime.runPromise(ModelService);
    const command = Schema.decodeUnknownSync(Command);
    await runtime.runPromise(model.command(command({ _tag: "CreateCanvas", canvas: "factory" }), "operator"));
    await runtime.runPromise(model.command(command({ _tag: "Add", canvas: "factory", nodes: [{
      kind: "board", id: "board", x: 0, y: 0, width: 200, height: 100, z: 0, label: "Board",
    }, { kind: "task", id: "tasks", x: 0, y: 0, width: 200, height: 100, z: 1 },
    { kind: "requests", id: "asks", x: 0, y: 0, width: 200, height: 100, z: 2 },
    { kind: "artifacts", id: "artifacts", x: 0, y: 0, width: 200, height: 100, z: 3 },
    { kind: "agent", id: "seat", x: 0, y: 0, width: 200, height: 100, z: 4,
      agentKey: "local:claude", label: "Seat", host: "local", overseer: false,
      bindingId: "seat-binding", harness: "claude", onRemove: "detach" }], wires: [] }), "operator"));
    const repo = await runtime.runPromise(WorkRepository);
    const sink = { canvasName: "factory", nodeId: "board" };
    const basis = Schema.decodeUnknownSync(CanvasFactBasis)({ kind: "canvas", canvasName: "factory", seq: 1 });
    const author = { kind: "operator" as const };
    const at = "2026-10-07T00:00:00.000Z";
    for (const topicId of ["selected", "unrelated"]) {
      await runtime.runPromise(repo.createBoardTopic({ sink, basis, createdBy: author, topic: {
        topicId, title: topicId, state: "open", openedBy: author, openedAt: at, postCount: 0, lastActivityAt: at,
      } }));
      await runtime.runPromise(repo.appendBoardPost({ sink, basis, createdBy: author, post: {
        postId: `post-${topicId}`, topicId, author, parts: [{ kind: "text", text: topicId }], position: 0, createdAt: at,
      } }));
    }
    const topology = await runtime.runPromise(model.canvas("factory"));
    const refs = await runtime.runPromise((await runtime.runPromise(ModelActorRefs)).read("factory"));
    const actor = refs[0]!;
    const dependencyScope = createCanvasTaskDependencyScopeCapability({ canvas: topology, authoringSink: { canvasName: "factory", nodeId: "tasks" } });
    const history = (id: string) => [{ messageId: `brief-${id}`, role: "user" as const, parts: [{ kind: "text" as const, text: id }] }];
    for (const [id, minute] of [["old", 1], ["new", 2], ["archived", 3]] as const) {
      const at = `2026-10-07T00:0${minute}:00.000Z`;
      await runtime.runPromise(repo.createTask({ sink: { canvasName: "factory", nodeId: "tasks" }, basis, dependencyScope,
        task: { id, state: "submitted", history: history(id), metadata: { priority: "high" },
          admission: "auto", waitUntil: "2026-10-08T00:00:00.000Z", visits: [{ board: "tasks", enteredAt: at, epoch: 0 }] },
        originAt: at, receivedAt: at }));
    }
    await runtime.runPromise(repo.transitionTask({ sink: { canvasName: "factory", nodeId: "tasks" }, basis, taskId: "archived", state: "archived" }));
    for (const [id, minute] of [["ask-old", 1], ["ask-new", 2]] as const) {
      const at = `2026-10-07T00:0${minute}:00.000Z`;
      await runtime.runPromise(repo.createRequest({ sink: { canvasName: "factory", nodeId: "asks" }, basis, raisedBy: actor,
        request: { id, state: "input-required", claimedBy: actor.seatId, history: history(id) }, originAt: at, receivedAt: at }));
    }
    await runtime.runPromise(repo.publishArtifact({ sink: { canvasName: "factory", nodeId: "artifacts" }, basis,
      artifact: { artifactId: "artifact", parts: [{ kind: "text", text: "large payload" }] }, publishedBy: actor }));
    await runtime.runPromise(repo.appendMessage({ sink: { canvasName: "factory", nodeId: "seat" }, basis,
      message: history("mail")[0]!, sentBy: actor, destination: { kind: "mailbox" } }));
    await runtime.runPromise(Effect.gen(function* () {
      yield* sql`PRAGMA ignore_check_constraints=ON`;
      yield* sql.withTransaction(unjournaledWorkMutationEffect("test.fixture-seed", Effect.gen(function* () {
        yield* sql`UPDATE work_board_posts SET parts_json='invalid JSON'`;
        yield* sql`UPDATE work_artifacts SET parts_json='invalid JSON'`;
        yield* sql`UPDATE work_messages SET parts_json='invalid JSON'`;
        yield* sql`UPDATE work_task_messages SET parts_json='invalid JSON' WHERE item_id='archived'`;
      }))).pipe(Effect.ensuring(sql`PRAGMA ignore_check_constraints=OFF`.pipe(Effect.asVoid, Effect.orDie)));
    }));
    const work = await runtime.runPromise(repo.kernelWork("factory"));
    expect([...work.tasks.keys()]).toEqual(["tasks", "asks"]);
    expect(work.tasks.get("tasks")?.map((task) => task.id)).toEqual(["old", "new"]);
    expect(work.tasks.get("tasks")?.[0]).toMatchObject({ history: history("old"), metadata: { priority: "high" },
      admission: "auto", waitUntil: "2026-10-08T00:00:00.000Z", visits: [{ board: "tasks", epoch: 0 }] });
    expect(work.tasks.get("asks")?.map((task) => task.id)).toEqual(["ask-new", "ask-old"]);
    expect(work.tasks.get("asks")?.[0]?.claimedBy).toBe(actor.seatId);
    expect([...work.boards]).toEqual([["board", { topics: 2, posts: 2 }]]);
    expect([...work.artifacts]).toEqual([["artifacts", 1]]);
    expect(await runtime.runPromise(repo.artifactIds("factory", "artifacts"))).toEqual(["artifact"]);
    expect(await runtime.runPromise(repo.artifactIds("another-canvas", "artifacts"))).toEqual([]);
    const live = await runtime.runPromise(readLiveCanvas("factory"));
    expect([...live.artifacts]).toEqual([["artifacts", ["artifact"]]]);
    expect(live.tasks.get("tasks")?.map((task) => task.id)).toEqual(["old", "new"]);
    const empty = await runtime.runPromise(repo.kernelWork("another-canvas"));
    expect(empty.tasks.size + empty.boards.size + empty.artifacts.size).toBe(0);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
