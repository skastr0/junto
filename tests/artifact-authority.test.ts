/**
 * Behind the authority (0.11/06 F2), through the real stores: an artifact
 * command is judged on its canvas's authority and lands when its entry
 * applies. With the authority off it is ruled here, in one transaction, as
 * before. The fold that lands it is tests/ruling-fold-equals-ruler.test.ts.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ authority: true }));
vi.mock("@shared/features", async (original) => ({
  ...(await original<typeof import("../src/shared/features")>()),
  get AUTHORITY_ENABLED() { return flags.authority; },
}));

import { makeContentServiceLive } from "../src/main/junto/content/service";
import { CanvasAuthoritiesLive } from "../src/main/junto/fleet/host";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepository, MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelRecords } from "../src/main/junto/model/records";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ArtifactRepository, ArtifactRepositoryLive } from "../src/main/junto/work/artifact-repository";
import { workProjectionChanges } from "../src/main/junto/work/projection-changes";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { asNodeId } from "../src/shared/model";
import type { ArtifactOp, ArtifactVersion } from "../src/shared/artifact";
import { mintOpId, type ResourceActor, type ResourceCommand, type RulingContext } from "../src/shared/resource-command";
import type { ItemId } from "../src/shared/work-ids";
import { nameThisMachine } from "./support/name-this-machine";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";
import { artifacts, seat } from "./support/model-nodes";

const NAME = "factory";
const ARTS = asNodeId("arts");
const ada: ResourceActor = { kind: "seat", seatId: `seat_${"a".repeat(64)}` as never, nodeId: asNodeId("ada") };
const everywhere: RulingContext = { inReach: () => true };

const makeRuntime = (dir: string) => {
  // The recorder sees the machine and the canvas, as core-product wires it, so an applied ruling writes any notices here.
  const recorder = Layer.provide(RulingRecorderLive, Layer.mergeAll(WorkRepositoryLive, MachineRepositoryLive, ModelRecords.layer));
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      MachineRepositoryLive,
      // The artifact ruler judges on the host's authorities.
      Layer.provide(
        ArtifactRepositoryLive,
        Layer.mergeAll(
          Layer.provideMerge(Layer.provide(CanvasAuthoritiesLive, MachineRepositoryLive), recorder),
          makeContentServiceLive({ root: join(dir, "content"), skipInlineMediaMigration: true }),
        ),
      ),
    ),
    Layer.mergeAll(makeStateEngineLive(join(dir, "junto.db")), makeInstallOpsLive(join(dir, "install-ops.db"))),
  );
  return ManagedRuntime.make(Layer.provideMerge(ModelStoresLive, repositories));
};

let dir: string | undefined;
let runtime: ReturnType<typeof makeRuntime> | undefined;
afterEach(async () => {
  clearMachines();
  await runtime?.dispose();
  runtime = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const boot = async (authority: boolean) => {
  flags.authority = authority;
  dir = await mkdtemp(join(tmpdir(), "junto-artifact-authority-"));
  runtime = makeRuntime(dir);
  await runtime.runPromise(nameThisMachine);
  seedThisMachine();
  await runtime.runPromise(seedCanvas(NAME, [seat("ada"), artifacts("arts", { x: 400 })]));
  return runtime;
};
type Runtime = Awaited<ReturnType<typeof boot>>;

const commandOf = (op: ArtifactOp, itemId: ItemId | undefined, actor: ResourceActor = { kind: "operator" }): ResourceCommand<ArtifactOp> => {
  const opId = mintOpId();
  return {
    opId,
    canvasName: NAME,
    actor,
    // A create names its artifact by its own op id.
    target: { kind: "artifact", nodeId: ARTS, itemId: itemId ?? (opId as unknown as ItemId) },
    basis: null,
    after: [],
    op,
  };
};

const submit = (command: ResourceCommand<ArtifactOp>) =>
  Effect.gen(function* () {
    const writer = yield* (yield* MachineRepository).installationId;
    return yield* (yield* ArtifactRepository).submit(writer, command, everywhere);
  });

const create = (actor?: ResourceActor) => commandOf({ op: "create", title: "Plan", body: { type: "document", markdown: "v1" } }, undefined, actor);

/** Read on a connection of its own, as another reader of the disk does. */
const onDisk = <A>(read: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(join(dir!, "junto.db"), { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
};
const count = (sql: string, ...values: Array<string>) => (onDisk((db) => db.prepare(sql).get(...values)) as { n: number }).n;
const headVersion = (id: string) =>
  (onDisk((db) => db.prepare("SELECT version FROM artifact_heads WHERE canvas_name = ? AND artifact_id = ?").get(NAME, id)) as { version: number } | undefined)?.version;

describe.each([false, true])("with the authority %s", (authority) => {
  it("an artifact is on disk once submit returns, and behind the authority submit refuses a caller's transaction", async () => {
    const rt = await boot(authority);
    const first = create();
    expect(await rt.runPromise(submit(first))).toMatchObject({ kind: "applied", version: 1 });
    expect(headVersion(first.target.itemId!)).toBe(1);
    // Judged rulings are logged on the canvas's authority; direct ones are not.
    expect(count("SELECT COUNT(*) AS n FROM canvas_log WHERE canvas_name = ? AND kind = 'ruling'", NAME) > 0).toBe(authority);
    const inside = await rt.runPromise(Effect.exit(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(submit(create())))));
    expect(inside._tag).toBe(authority ? "Failure" : "Success");
  });

  it("an edit is judged on the version the last one applied, and a stale base is refused", async () => {
    const rt = await boot(authority);
    const first = create();
    await rt.runPromise(submit(first));
    const id = first.target.itemId!;
    const edit = (base: number) => commandOf({ op: "edit", edit: { kind: "replace", baseVersion: base as ArtifactVersion, body: { type: "document", markdown: `on ${base}` } } }, id);
    expect(await rt.runPromise(submit(edit(1)))).toMatchObject({ kind: "applied", version: 2 });
    expect(await rt.runPromise(submit(edit(1)))).toMatchObject({ kind: "refused" });
    expect(headVersion(id)).toBe(2);
    // A resend is answered from its stored ruling and writes nothing more.
    const again = edit(2);
    await rt.runPromise(submit(again));
    expect(await rt.runPromise(submit(again))).toMatchObject({ kind: "applied", version: 3, facts: [] });
    expect(count("SELECT COUNT(*) AS n FROM artifact_versions WHERE canvas_name = ? AND artifact_id = ?", NAME, id)).toBe(3);
  });

  it("a seat's artifact is heard once it is on disk, and tells the seat nothing", async () => {
    const rt = await boot(authority);
    const command = create(ada);
    const heard: Array<number | undefined> = [];
    const sql = await rt.runPromise(SqlClient.SqlClient);
    const unsubscribe = workProjectionChanges(sql).subscribe((canvasName, nodeId, kind) => {
      if (canvasName === NAME && nodeId === ARTS && kind === "work") heard.push(headVersion(command.target.itemId!));
    });
    try {
      expect(await rt.runPromise(submit(command))).toMatchObject({ kind: "applied", version: 1 });
    } finally {
      unsubscribe();
    }
    // Every announcement finds the artifact applied: none is heard before its row lands.
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((version) => version === 1)).toBe(true);
    // An artifact ruling owes no seat a notice (ruling-notices.ts), judged or not.
    expect(count("SELECT COUNT(*) AS n FROM work_messages WHERE canvas_name = ? AND node_id = ?", NAME, "ada")).toBe(0);
  });
});
