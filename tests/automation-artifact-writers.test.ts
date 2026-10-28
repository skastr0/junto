/**
 * Loop safety for artifact writes (B1), on the real state engine and the
 * production ruling path: an artifact whose newest applied ruling is an
 * automation's is the automation's, however many rulings the canvas took
 * since, and a read that fails says the automation's, never no one's.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactsWrittenByAutomation } from "../src/main/junto/automation/artifact-writers";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ArtifactRepository, ArtifactRepositoryLive } from "../src/main/junto/work/artifact-repository";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import type { ArtifactOp } from "../src/shared/artifact";
import { InstallationId } from "../src/shared/installation-id";
import type { ResourceActor, ResourceCommand } from "../src/shared/resource-command";
import { rulingContextOf } from "../src/shared/ruling-context";
import { ItemId, OpId } from "../src/shared/work-ids";
import { artifacts, canvasOf } from "./support/model-nodes";
import { seedCanvasRows } from "./support/seed-canvas";

const EDITOR = Schema.decodeUnknownSync(InstallationId)("macbook");
const at = "2026-10-28T12:00:00.000Z";
const nodes = [artifacts("arts-1", { y: 0 })];
const automation = { kind: "automation", nodeId: "automations-1", automationId: "01M5F4C0000000000000000001" } as unknown as ResourceActor;
const operator: ResourceActor = { kind: "operator" };
let next = 0;
const op = () => Schema.decodeUnknownSync(OpId)(`01M5F4A${String(next++).padStart(19, "0")}`);
const item = (n: number) => Schema.decodeUnknownSync(ItemId)(`01M5F4B${String(n).padStart(19, "0")}`);
const SPEC = item(1);
const BUSY = item(2);

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<ArtifactRepository | SqlClient.SqlClient, unknown>;

beforeAll(async () => {
  root = join(tmpdir(), `junto-artifact-writers-${randomUUID()}`);
  const state = Layer.mergeAll(makeStateEngineLive(join(root, "state", "junto.db")), makeInstallOpsLive(join(root, "state", "install-ops.db")));
  const services = Layer.provideMerge(
    ArtifactRepositoryLive,
    Layer.provideMerge(
      Layer.mergeAll(RulingRecorderLive, makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true })),
      Layer.provideMerge(WorkRepositoryLive, state),
    ),
  );
  runtime = ManagedRuntime.make(services as never) as typeof runtime;
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${EDITOR}, ${at})`;
      yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${EDITOR}, ${at})`;
      yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes }]]) });
    }));
  }));
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const write = (actor: ResourceActor, artifactId: ItemId, written: ArtifactOp) =>
  runtime.runPromise(Effect.gen(function* () {
    const repository = yield* ArtifactRepository;
    const command = {
      opId: op(),
      canvasName: "factory",
      actor,
      target: { kind: "artifact", nodeId: "arts-1", itemId: artifactId },
      basis: null,
      after: [],
      op: written,
    } as unknown as ResourceCommand<ArtifactOp>;
    const context = rulingContextOf(canvasOf(nodes), () => ({ kind: "operator" }) as never);
    const outcome = yield* repository.submit(EDITOR, command, { ...context, inReach: () => true });
    expect(outcome.kind).toBe("applied");
  }));

const automated = (ids: ReadonlyArray<string>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => artifactsWrittenByAutomation(sql, "factory", ids)));

describe("artifactsWrittenByAutomation", () => {
  it("names the artifact an automation wrote last, and not one a person wrote after it", async () => {
    await write(operator, SPEC, { op: "create", title: "Spec", body: { type: "document", markdown: "x" } });
    await write(operator, BUSY, { op: "create", title: "Busy", body: { type: "document", markdown: "x" } });
    expect(await automated([SPEC, BUSY])).toEqual(new Set());
    await write(automation, SPEC, { op: "labels", labels: ["published"] });
    expect(await automated([SPEC, BUSY])).toEqual(new Set([SPEC]));
    await write(operator, SPEC, { op: "labels", labels: ["published", "seen"] });
    expect(await automated([SPEC])).toEqual(new Set());
  });

  it("still names it with more than 2,000 rulings on other artifacts after it", async () => {
    await write(automation, SPEC, { op: "labels", labels: ["published", "seen", "again"] });
    for (let n = 0; n < 2_005; n += 1) await write(operator, BUSY, { op: "labels", labels: [n % 2 === 0 ? "even" : "odd"] });
    expect(await automated([SPEC, BUSY])).toEqual(new Set([SPEC]));
  }, 300_000);

  it("says every changed artifact is an automation's when the rulings cannot be read", async () => {
    // A client whose every query fails, as a closed database does.
    const closed = (() => Effect.fail(new Error("closed"))) as unknown as SqlClient.SqlClient;
    expect(await Effect.runPromise(artifactsWrittenByAutomation(closed, "factory", [SPEC, BUSY]))).toEqual(new Set([SPEC, BUSY]));
  });
});
