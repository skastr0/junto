/**
 * The code allowance (docs/security-doctrine.md, Code steps, check 4): rows
 * in this machine's database, written by the owner through the core. A canvas
 * this machine does not hold and a machine it does not know are refused with
 * the nearest names; with no machine named, the canvas's ruling installation
 * is trusted. Nothing that crosses a link names the tables.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { MODEL_STATE_SCHEMA_SQL } from "../src/main/junto/model/state-schema";
import { MACHINE_STATE_SCHEMA_SQL } from "../src/main/junto/machines/state-schema";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelRecords } from "../src/main/junto/model/records";
import { MACHINE_CODE_ALLOWANCES_SQL, MACHINE_CODE_ALLOWANCE_TABLES } from "../src/main/junto/automation/code-allowance-schema";
import { CodeAllowanceRepository, CodeAllowanceRepositoryLive } from "../src/main/junto/automation/code-allowance";
import { makeCodeAllowanceOwner } from "../src/main/junto/automation/code-allowance-owner";

const MACBOOK = "inst-macbook";
const VPS = "inst-vps";

let database: DatabaseSync;
let runtime: ManagedRuntime.ManagedRuntime<CodeAllowanceRepository | MachineRepository | ModelRecords | SqlClient.SqlClient, unknown>;

const run = <A, E>(effect: Effect.Effect<A, E, CodeAllowanceRepository | MachineRepository | ModelRecords | SqlClient.SqlClient>) =>
  runtime.runPromise(effect);
const owner = () => run(makeCodeAllowanceOwner);
const refusal = async <A, E>(effect: Effect.Effect<A, E, CodeAllowanceRepository | MachineRepository | ModelRecords | SqlClient.SqlClient>): Promise<string> => {
  const exit = await runtime.runPromiseExit(effect);
  if (exit._tag === "Success") throw new Error("expected a refusal");
  return String(JSON.stringify(exit.cause)) + String(exit.cause);
};

beforeEach(async () => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(MACHINE_STATE_SCHEMA_SQL + MODEL_STATE_SCHEMA_SQL + MACHINE_CODE_ALLOWANCES_SQL);
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  runtime = ManagedRuntime.make(Layer.mergeAll(
    CodeAllowanceRepositoryLive,
    makeMachineRepositoryLive({ defaultName: () => "mini" }),
    ModelRecords.layer,
  ).pipe(Layer.provideMerge(sql)));
  await run(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [name, id] of [["macbook", MACBOOK], ["vps", VPS]] as const) {
      yield* sql`INSERT INTO known_installations (installation_id, registered_at) VALUES (${id}, 'now')`;
      yield* sql`INSERT INTO machine_peers (machine_name, installation_id, bound_at) VALUES (${name}, ${id}, 'now')`;
    }
    yield* sql`INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at, editor_installation_id)
      VALUES ('factory', 'canvas-1', 'now', 'now', ${MACBOOK})`;
  }));
});

afterEach(async () => {
  await runtime.dispose();
  database.close();
});

describe("the code allowance", () => {
  it("is nothing until the owner allows a canvas, and then trusts its editing machine by default", async () => {
    const code = await owner();
    expect(await run(code.show({}))).toEqual({ allowances: [] });
    const allowed = await run(code.allow({ canvas: "factory" }));
    expect(allowed).toEqual({
      canvas: "factory",
      allowance: { canvas: "factory", scope: "operator-and-overseers", rulers: [{ installationId: MACBOOK, machineName: "macbook" }] },
    });
    expect(await run(Effect.flatMap(CodeAllowanceRepository, (store) => store.read("factory"))))
      .toEqual({ scope: "operator-and-overseers", installations: [MACBOOK] });
  });

  it("takes machines by short name or id, replaces the list whole, and narrows the scope", async () => {
    const code = await owner();
    await run(code.allow({ canvas: "factory", rulers: ["macbook", VPS] }));
    const narrowed = await run(code.allow({ canvas: "factory", rulers: ["vps"], scope: "operator" }));
    expect(narrowed.allowance).toEqual({ canvas: "factory", scope: "operator", rulers: [{ installationId: VPS, machineName: "vps" }] });
  });

  it("refuses a machine it does not know, naming the nearest", async () => {
    const code = await owner();
    const words = await refusal(code.allow({ canvas: "factory", rulers: ["macbok"] }));
    expect(words).toContain("This machine knows no machine named macbok; nearest: macbook");
  });

  it("refuses a canvas this machine does not hold, naming the nearest", async () => {
    const code = await owner();
    const words = await refusal(code.allow({ canvas: "factori" }));
    expect(words).toContain("This machine holds no canvas named factori; nearest: factory");
  });

  it("is withdrawn by deny, and goes with its canvas", async () => {
    const code = await owner();
    await run(code.allow({ canvas: "factory" }));
    expect(await run(code.deny({ canvas: "factory" }))).toEqual({ canvas: "factory", allowance: null });
    await run(code.allow({ canvas: "factory" }));
    database.exec("DELETE FROM canvases WHERE canvas_name = 'factory'");
    expect(database.prepare("SELECT count(*) AS n FROM machine_code_allowance_installations").get()).toEqual({ n: 0 });
    expect(await run(code.show({}))).toEqual({ allowances: [] });
  });
});

describe("the allowance never crosses", () => {
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
  const root = join(__dirname, "..", "src");
  const crossing = [
    ...sources(join(root, "main", "junto", "work", "exchange")),
    ...sources(join(root, "main", "junto", "link")),
    join(root, "shared", "canvas-copy.ts"),
    join(root, "shared", "work-exchange.ts"),
  ];

  it("is named by nothing in the exchange, the link or the canvas copy", () => {
    expect(crossing.length).toBeGreaterThan(3);
    for (const file of crossing) {
      const text = readFileSync(file, "utf8");
      for (const table of MACHINE_CODE_ALLOWANCE_TABLES) expect(text.includes(table), `${file} names ${table}`).toBe(false);
    }
  });
});
