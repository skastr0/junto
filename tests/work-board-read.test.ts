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
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { unjournaledWorkMutationEffect } from "../src/main/junto/work/mutation-seam";

it("reads the selected board topic without decoding another topic's contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-board-read-"));
  const modelLive = Layer.provideMerge(Layer.provide(ModelLive, ModelDependents.empty), makeStateEngineLive(join(root, "junto.db")));
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, modelLive));
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
    }], wires: [] }), "operator"));
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
    expect(await runtime.runPromise(repo.boardTopics("factory", "board"))).toHaveLength(2);
    await runtime.runPromise(Effect.gen(function* () {
      yield* sql`PRAGMA ignore_check_constraints=ON`;
      yield* sql.withTransaction(unjournaledWorkMutationEffect("test.fixture-seed",
        sql`UPDATE work_board_posts SET parts_json='invalid unrelated JSON' WHERE canvas_name='factory' AND node_id='board' AND topic_id='unrelated'`,
      )).pipe(Effect.ensuring(sql`PRAGMA ignore_check_constraints=OFF`.pipe(Effect.asVoid, Effect.orDie)));
    }));
    expect(await runtime.runPromise(repo.boardTopics("factory", "board", "selected"))).toMatchObject([
      { topicId: "selected", posts: [{ parts: [{ kind: "text", text: "selected" }] }] },
    ]);
    expect(await runtime.runPromise(repo.boardTopics("factory", "board", "missing"))).toEqual([]);
    await expect(runtime.runPromise(repo.boardTopics("factory", "board"))).rejects.toThrow();
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
