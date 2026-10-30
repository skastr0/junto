/**
 * A canvas's placement carries its committed authority list (0.11/06 F3):
 * each listed machine keeps the canvas whole, so placement names them in
 * order and counts each a holder beside the machines its seats and
 * automations live on. A canvas with no list seeded reads as its editor
 * alone, which is every canvas until the operator lists a fallback.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelRecords } from "../src/main/junto/model/records";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { canvasPlacement } from "../src/main/junto/work/canvas-placement";
import { InstallationId } from "../src/shared/installation-id";
import { authoritiesOf, authorityOf } from "../src/shared/work-exchange";
import { nameThisMachine } from "./support/name-this-machine";
import { seedCanvasRows } from "./support/seed-canvas";

const id = Schema.decodeUnknownSync(InstallationId);
const SELF = id("macbook");
const MINI = id("mini");
const VPS = id("vps");
const NAME = "factory";

let dir: string | undefined;
let runtime: ManagedRuntime.ManagedRuntime<ModelRecords | MachineRepository | SqlClient.SqlClient, unknown> | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const boot = async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-placement-authorities-"));
  runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.mergeAll(ModelRecords.layer, makeMachineRepositoryLive({ makeInstallationId: () => SELF, defaultName: () => "macbook" })),
      makeStateEngineLive(join(dir, "junto.db")),
    ),
  );
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(seedCanvasRows({ seq: 7, canvases: new Map([[NAME, { nodes: [] }]]) }));
  return runtime;
};

const list = (canvas: string, entries: ReadonlyArray<readonly [position: number, machine: InstallationId]>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(entries, ([position, machine]) =>
      sql`INSERT INTO canvas_authorities (canvas_name, position, installation_id) VALUES (${canvas}, ${position}, ${machine})`,
    ),
  );

describe("a canvas's committed list on its placement", () => {
  it("reads the editor alone where no list is seeded", async () => {
    const rt = await boot();
    const placement = await rt.runPromise(canvasPlacement(NAME));
    expect(placement?.authorities).toEqual([SELF]);
    expect(placement?.holds(SELF)).toBe(true);
    expect(placement?.holds(MINI)).toBe(false);
    expect(authorityOf(placement!)).toBe(SELF);
    expect(authoritiesOf(placement!)).toEqual([SELF]);
  });

  it("names every listed machine in position order and counts each a holder", async () => {
    const rt = await boot();
    await rt.runPromise(list(NAME, [[2, VPS], [0, SELF], [1, MINI]]));
    const placement = await rt.runPromise(canvasPlacement(NAME));
    expect(placement?.authorities).toEqual([SELF, MINI, VPS]);
    for (const machine of [SELF, MINI, VPS]) expect(placement?.holds(machine)).toBe(true);
    expect(placement?.holds(id("stranger"))).toBe(false);
    expect(authoritiesOf(placement!)).toEqual([SELF, MINI, VPS]);
  });

  it("follows the committed list: a removed machine keeps the canvas no more", async () => {
    const rt = await boot();
    await rt.runPromise(list(NAME, [[0, SELF], [1, MINI]]));
    expect((await rt.runPromise(canvasPlacement(NAME)))?.holds(MINI)).toBe(true);
    await rt.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM canvas_authorities WHERE canvas_name=${NAME} AND installation_id=${MINI}`),
    );
    const placement = await rt.runPromise(canvasPlacement(NAME));
    expect(placement?.authorities).toEqual([SELF]);
    expect(placement?.holds(MINI)).toBe(false);
  });

  it("authoritiesOf reads a placement that names none as its editor alone", () => {
    expect(authoritiesOf({ editor: SELF })).toEqual([SELF]);
    expect(authoritiesOf({ editor: SELF, authorities: [] })).toEqual([SELF]);
    expect(authoritiesOf({ editor: SELF, authorities: [SELF, MINI] })).toEqual([SELF, MINI]);
  });
});
