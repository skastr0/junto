import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { createCanvasTaskDependencyScopeCapability, WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { WorkModelDependentsLive } from "../src/main/junto/work/model-dependents";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ActorRef, IntentFactBasis } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { artifacts, board, canvasOf, note, seat, taskBoard } from "./support/model-nodes";

it("removes mailbox rows in the owning transaction and preserves immutable records", async () => {
  const root = join(tmpdir(), `junto-work-removal-${randomUUID()}`);
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* WorkRepository;
      const tasks = taskBoard("tasks");
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO station_known_installations VALUES ('local-installation','2026-10-07')`;
        yield* sql`INSERT INTO station_installation VALUES (1,'local-installation','2026-10-07')`;
        yield* sql`INSERT INTO station_configuration(singleton,role,host_id,agent_host_id,command_center_installation_id,supervised_preferred,configured_at) VALUES (1,'command-center','local',NULL,NULL,1,'2026-10-07')`;
        yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", {
          nodes: [...["sender", "inbox", "other"].map((id) => seat(id)), note("empty-note"), board("board"), tasks, artifacts("artifacts")],
        }]]) });
      }));
      const sentBy = Schema.decodeUnknownSync(ActorRef)({ seatId: `seat_${"a".repeat(64)}`, canvasName: "factory", nodeId: "sender" });
      const basis = Schema.decodeUnknownSync(IntentFactBasis)({ kind: "canvas", canvasName: "factory", seq: 1 });
      const taskSink = { canvasName: "factory", nodeId: "tasks" };
      const dependencyScope = createCanvasTaskDependencyScopeCapability({ canvas: { ...canvasOf([tasks]), seq: 1 }, authoringSink: taskSink });
      yield* repo.createTask({ sink: taskSink, basis, dependencyScope,
        task: { id: "task", state: "submitted", history: [{ messageId: "brief", role: "user", parts: [{ kind: "text", text: "Task" }] }] },
      });
      yield* repo.claimLocalTask({ sink: taskSink, basis, dependencyScope, taskId: "task", actor: sentBy });
      const artifactSink = { canvasName: "factory", nodeId: "artifacts" };
      yield* repo.publishArtifact({ sink: artifactSink, basis, publishedBy: sentBy,
        artifact: { artifactId: "artifact", parts: [{ kind: "text", text: "Result" }], task: { kind: "task", sink: taskSink, itemId: "task" } },
      });
      for (const nodeId of ["inbox", "other"]) yield* repo.appendMessage({
        sink: { canvasName: "factory", nodeId }, basis, sentBy, destination: { kind: "mailbox" },
        message: { messageId: `mail-${nodeId}`, role: "agent", parts: [{ kind: "text", text: nodeId }] },
      });
      const inbox = { canvasName: "factory", nodeId: "inbox" };
      yield* repo.acceptDelivery({ sink: inbox, basis, receipt: {
        deliveryId: "delivered-inbox", deliveredItem: { kind: "message", sink: inbox, itemId: "mail-inbox" },
        actor: sentBy, acceptedAt: "2026-10-07",
      } });
      const boardSink = { canvasName: "factory", nodeId: "board" };
      const author = { kind: "operator" as const };
      yield* repo.createBoardTopic({ sink: boardSink, basis, createdBy: author, topic: {
        topicId: "topic", title: "Topic", state: "open", openedBy: author, openedAt: "2026-10-07", postCount: 0, lastActivityAt: "2026-10-07",
      } });
      yield* repo.appendBoardPost({ sink: boardSink, basis, createdBy: author, post: {
        postId: "post", topicId: "topic", author, parts: [{ kind: "text", text: "Post" }], position: 0, createdAt: "2026-10-07",
      } });
      const recordsBefore = yield* sql`SELECT * FROM work_events ORDER BY seq`;
      const factsBefore = yield* sql`SELECT * FROM work_facts ORDER BY seq`;
      const notifications: Array<{ canvasName: string; nodeId: string; kind?: "work" | "mail" }> = [];
      const unsubscribe = repo.subscribeChanges((canvasName, nodeId, kind) => notifications.push({ canvasName, nodeId, kind }));
      yield* Effect.gen(function* () {
        const dependents = yield* ModelDependents;
        yield* sql.withTransaction(dependents.removeNodes("factory", ["empty-note", "missing"]));
        expect(notifications).toEqual([]);
        const aborted = yield* sql.withTransaction(Effect.gen(function* () {
          yield* dependents.removeNodes("factory", ["inbox", "tasks"]);
          expect((yield* repo.mailbox("factory", "inbox"))).toEqual([]);
          expect(notifications).toEqual([]);
          return yield* Effect.fail("abort");
        })).pipe(Effect.result);
        expect(aborted._tag).toBe("Failure");
        expect(notifications).toEqual([]);
        expect((yield* repo.mailbox("factory", "inbox"))).toHaveLength(1);
        expect((yield* repo.artifactIds("factory", "artifacts"))).toEqual(["artifact"]);
        yield* sql.withTransaction(dependents.removeNodes("factory", ["inbox", "tasks"]));
        expect(notifications.splice(0)).toEqual([
          { canvasName: "factory", nodeId: "artifacts", kind: "work" },
          { canvasName: "factory", nodeId: "inbox", kind: "mail" },
          { canvasName: "factory", nodeId: "tasks", kind: "work" },
        ]);
        expect((yield* repo.artifactIds("factory", "artifacts"))).toEqual([]);
        expect((yield* repo.mailbox("factory", "inbox"))).toEqual([]);
        expect((yield* repo.mailbox("factory", "other"))).toHaveLength(1);
        yield* sql.withTransaction(dependents.removeCanvas("factory"));
        expect(notifications.splice(0)).toEqual([
          { canvasName: "factory", nodeId: "board", kind: "work" },
          { canvasName: "factory", nodeId: "other", kind: "mail" },
        ]);
        yield* sql.withTransaction(dependents.removeCanvas("factory"));
        expect(notifications).toEqual([]);
        expect((yield* repo.mailbox("factory", "other"))).toEqual([]);
        expect(yield* sql`SELECT * FROM work_events ORDER BY seq`).toEqual(recordsBefore);
        expect(yield* sql`SELECT * FROM work_facts ORDER BY seq`).toEqual(factsBefore);
        expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      }).pipe(Effect.provide(WorkModelDependentsLive));
      unsubscribe();
    }));
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
