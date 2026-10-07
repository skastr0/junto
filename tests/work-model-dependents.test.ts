import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { WorkModelDependentsLive } from "../src/main/junto/work/model-dependents";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ActorRef, IntentFactBasis } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";

it("removes mailbox rows in the owning transaction and preserves immutable records", async () => {
  const root = join(tmpdir(), `junto-work-removal-${randomUUID()}`);
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* WorkRepository;
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO station_known_installations VALUES ('local-installation','2026-10-07')`;
        yield* sql`INSERT INTO station_installation VALUES (1,'local-installation','2026-10-07')`;
        yield* sql`INSERT INTO station_configuration(singleton,role,host_id,agent_host_id,command_center_installation_id,supervised_preferred,configured_at) VALUES (1,'command-center','local',NULL,NULL,1,'2026-10-07')`;
        yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", {
          nodes: ["sender", "inbox", "other"].map((id) => seat(id)),
        }]]) });
      }));
      const sentBy = Schema.decodeUnknownSync(ActorRef)({ seatId: `seat_${"a".repeat(64)}`, canvasName: "factory", nodeId: "sender" });
      const basis = Schema.decodeUnknownSync(IntentFactBasis)({ kind: "canvas", canvasName: "factory", seq: 1 });
      for (const nodeId of ["inbox", "other"]) yield* repo.appendMessage({
        sink: { canvasName: "factory", nodeId }, basis, sentBy, destination: { kind: "mailbox" },
        message: { messageId: `mail-${nodeId}`, role: "agent", parts: [{ kind: "text", text: nodeId }] },
      });
      const recordsBefore = yield* sql`SELECT * FROM work_events ORDER BY seq`;
      const factsBefore = yield* sql`SELECT * FROM work_facts ORDER BY seq`;
      yield* Effect.gen(function* () {
        const dependents = yield* ModelDependents;
        const aborted = yield* sql.withTransaction(Effect.gen(function* () {
          yield* dependents.removeNodes("factory", ["inbox"]);
          expect((yield* repo.mailbox("factory", "inbox"))).toEqual([]);
          return yield* Effect.fail("abort");
        })).pipe(Effect.result);
        expect(aborted._tag).toBe("Failure");
        expect((yield* repo.mailbox("factory", "inbox"))).toHaveLength(1);
        yield* sql.withTransaction(dependents.removeNodes("factory", ["inbox"]));
        expect((yield* repo.mailbox("factory", "inbox"))).toEqual([]);
        expect((yield* repo.mailbox("factory", "other"))).toHaveLength(1);
        yield* sql.withTransaction(dependents.removeCanvas("factory"));
        expect((yield* repo.mailbox("factory", "other"))).toEqual([]);
        expect(yield* sql`SELECT * FROM work_events ORDER BY seq`).toEqual(recordsBefore);
        expect(yield* sql`SELECT * FROM work_facts ORDER BY seq`).toEqual(factsBefore);
        expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      }).pipe(Effect.provide(WorkModelDependentsLive));
    }));
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
