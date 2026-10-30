/**
 * Behind the authority (0.11/06 F4, slice 2), through the real stores: a
 * canvas command is judged on its canvas's authority, kept as a
 * `structure.changed` entry, and answers once that entry applies, written
 * and published by the fold. With the authority off it rules here, as
 * before. The fold's equality with the command is
 * tests/structure-fold-equals-command.test.ts.
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

import { CanvasAuthoritiesLive } from "../src/main/junto/fleet/host";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelRecords } from "../src/main/junto/model/records";
import { ModelService } from "../src/main/junto/model/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { asCanvasName, asNodeId, type Changed, type Command } from "../src/shared/model";
import { note, seat } from "./support/model-nodes";
import { nameThisMachine } from "./support/name-this-machine";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";

const NAME = asCanvasName("factory");

const makeRuntime = (dir: string) => {
  const recorder = Layer.provide(RulingRecorderLive, Layer.mergeAll(WorkRepositoryLive, MachineRepositoryLive, ModelRecords.layer));
  const repositories = Layer.provideMerge(
    Layer.mergeAll(WorkRepositoryLive, MachineRepositoryLive, Layer.provideMerge(Layer.provide(CanvasAuthoritiesLive, MachineRepositoryLive), recorder)),
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
  dir = await mkdtemp(join(tmpdir(), "junto-canvas-command-authority-"));
  runtime = makeRuntime(dir);
  await runtime.runPromise(nameThisMachine);
  seedThisMachine();
  await runtime.runPromise(seedCanvas(NAME, [seat("ada")]));
  const published: Array<Changed> = [];
  await runtime.runPromise(Effect.map(ModelService, (model) => model.subscribeChanges((event) => published.push(event))));
  return { rt: runtime, published };
};

const run = (command: Command) => runtime!.runPromiseExit(Effect.flatMap(ModelService, (model) => model.command(command, "operator")));

/** Read on a connection of its own, as another reader of the disk does. */
const onDisk = <A>(read: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(join(dir!, "junto.db"), { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
};
const structureEntries = () =>
  onDisk((db) => db.prepare(`SELECT l.structure_seq AS seq, s.change_json AS change FROM canvas_log l
    JOIN canvas_log_structure s USING (canvas_name, log_index) WHERE l.canvas_name = ? ORDER BY l.log_index`).all(NAME)) as Array<{ seq: number; change: string }>;
const seqOnDisk = () => (onDisk((db) => db.prepare("SELECT seq FROM canvases WHERE canvas_name = ?").get(NAME)) as { seq: number }).seq;
const notesOnDisk = () => onDisk((db) => db.prepare("SELECT id FROM notes WHERE canvas_name = ? ORDER BY id").all(NAME)).map((row) => (row as { id: string }).id);

describe.each([false, true])("with the authority %s", (authority) => {
  it("a command is on disk and published once when it answers, and behind the authority it is a structure entry carrying its change", async () => {
    const { published } = await boot(authority);
    const before = seqOnDisk();
    const entriesBefore = structureEntries().length;
    const exit = await run({ _tag: "Add", canvas: NAME, nodes: [note("n1")], wires: [] });
    expect(exit).toMatchObject({ _tag: "Success", value: { seq: before + 1 } });
    expect(notesOnDisk()).toEqual(["n1"]);
    expect(seqOnDisk()).toBe(before + 1);
    expect(published.map((event) => [event.seq, event.nodes.map((node) => node.id)])).toEqual([[before + 1, ["n1"]]]);
    const added = structureEntries().slice(entriesBefore);
    if (authority) {
      expect(added).toHaveLength(1);
      expect(added[0]!.seq).toBe(before + 1);
      expect(JSON.parse(added[0]!.change)).toMatchObject({ nodes: [{ id: "n1", kind: "note" }], wires: [], removedNodes: [], removedWires: [] });
    } else {
      expect(added).toEqual([]);
    }
  });

  it("a refusal answers the same, logs nothing and changes nothing", async () => {
    const { published } = await boot(authority);
    const before = { seq: seqOnDisk(), entries: structureEntries().length };
    const exit = await run({ _tag: "Edit", canvas: NAME, id: asNodeId("ghost"), change: { kind: "note", text: "boo" } });
    expect(exit._tag).toBe("Failure");
    expect({ seq: seqOnDisk(), entries: structureEntries().length }).toEqual(before);
    expect(published).toEqual([]);
  });

  it("a command that changes nothing answers at the count it found and logs nothing", async () => {
    const { published } = await boot(authority);
    const before = { seq: seqOnDisk(), entries: structureEntries().length };
    const exit = await run({ _tag: "Recolor", canvas: NAME, nodes: [], color: null });
    expect(exit).toMatchObject({ _tag: "Success", value: { seq: before.seq } });
    expect({ seq: seqOnDisk(), entries: structureEntries().length }).toEqual(before);
    expect(published).toEqual([]);
  });

  it("removes a canvas one machine holds, and refuses one a longer list holds", async () => {
    await boot(authority);
    await runtime!.runPromise(Effect.flatMap(ModelService, (model) => model.command({ _tag: "CreateCanvas", canvas: asCanvasName("spare") }, "operator")));
    await runtime!.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`INSERT INTO canvas_authorities (canvas_name, position, installation_id)
        VALUES (${NAME}, 0, 'mini'), (${NAME}, 1, 'macbook') ON CONFLICT DO NOTHING`),
    );
    const listed = await run({ _tag: "RemoveCanvas", canvas: NAME });
    if (authority) expect(String(listed._tag === "Failure" ? listed.cause : "")).toMatch(/other machines off this canvas's list/);
    else expect(listed._tag).toBe("Success");
    expect((await run({ _tag: "RemoveCanvas", canvas: asCanvasName("spare") }))._tag).toBe("Success");
  });
});
