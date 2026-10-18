/**
 * State migration 20 -> 21 gives every machine a real name. Proven on both
 * shipped fixtures brought to version 20 by the real steps, with rows of every
 * kind that named a machine: where a row said `local` it now names this
 * machine, a row that named another machine still does, the identity tables
 * keep their rows under their plain names with every reference following
 * them, and every other table is untouched.
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { machineNameAtMigration } from "../src/main/junto/state/machine-name-at-migration";
import { migrateMachineNames } from "../src/main/junto/state/migrate-machine-names";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V20_IDENTITY,
  STATE_SCHEMA_V21_IDENTITY,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity, verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V20_SQL } from "./fixtures/state-v1/schema";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const openCopy = async (fixture: string): Promise<DatabaseSync> => {
  dir = await mkdtemp(join(tmpdir(), "junto-machine-names-migration-"));
  const path = join(dir, "junto.db");
  await copyFile(fileURLToPath(new URL(`./fixtures/state-v1/${fixture}`, import.meta.url)), path);
  const database = new DatabaseSync(path, { open: true, readOnly: false, allowExtension: false, enableForeignKeyConstraints: true });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const tables = (database: DatabaseSync): ReadonlyArray<string> =>
  (
    database
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'state_schema_identity'
          ORDER BY name`,
      )
      .all() as unknown as ReadonlyArray<{ readonly name: SQLOutputValue }>
  ).map(({ name }) => String(name));

const snapshot = (database: DatabaseSync) =>
  Object.fromEntries(tables(database).map((name) => [name, database.prepare(`SELECT * FROM "${name}"`).all()]));

const versionTwentyPlan = {
  ...STATE_SCHEMA_MIGRATION_PLAN,
  currentVersion: 20,
  currentSchemaSql: STATE_SCHEMA_V20_SQL,
  migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 20),
};

/** The real step, with the name first boot would give fixed so the proof does not depend on where it runs. */
const namedPlan = (firstBootName: string) => ({
  ...STATE_SCHEMA_MIGRATION_PLAN,
  migrations: STATE_SCHEMA_MIGRATIONS.map((step) =>
    step.toVersion === 21
      ? { ...step, migrate: (database: Parameters<typeof step.migrate>[0]) => migrateMachineNames(database, firstBootName) }
      : step,
  ),
});

const at = "2026-10-09T00:00:00.000Z";

/** The tables this step changes; every other table must come through row for row. */
const CHANGED = [
  "station_configuration",
  "station_fleet_targets",
  "station_known_installations",
  "station_installation",
  "known_installations",
  "installation",
  "machine_configuration",
  "machine_peers",
  "host_registry",
  "host_registry_state",
  "seats",
  "terminals",
  "pages",
  "crons",
  "relays",
  "watchers",
  "regions",
  "scheduler_interval_state",
  "station_status_facts",
];

const untouched = (rows: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(rows).filter(([name]) => !CHANGED.includes(name)));

/**
 * Rows of every kind that names a machine, each once for this machine (the
 * word `local`) and once for the mini, plus a machine the old list pinned.
 */
const seed = (database: DatabaseSync): void => {
  database
    .prepare("INSERT OR IGNORE INTO canvases(canvas_name, canvas_id, created_at, updated_at) VALUES ('factory', 'canvas-factory', ?, ?)")
    .run(at, at);
  const frame = "canvas_name, id, x, y, width, height, z_index, created_at, updated_at";
  const framed = (id: string) => ["factory", id, 0, 0, 240, 100, 0, at, at] as const;
  for (const host of ["local", "mini"]) {
    database
      .prepare(
        `INSERT INTO seats(${frame}, agent_key, label, host, binding_id, harness, on_remove, overseer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claude', 'detach', 0)`,
      )
      .run(...framed(`seat-${host}`), `${host}:claude`, `seat-${host}`, host, `binding-seat-${host}`);
    database
      .prepare(`INSERT INTO terminals(${frame}, host, binding_id, on_remove) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'detach')`)
      .run(...framed(`terminal-${host}`), host, `binding-terminal-${host}`);
    database
      .prepare(`INSERT INTO pages(${frame}, url, host, profile, on_remove) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'https://example.com', ?, 'work', 'detach')`)
      .run(...framed(`page-${host}`), host);
    database.prepare(`INSERT INTO crons(${frame}, host) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...framed(`cron-${host}`), host);
    database.prepare(`INSERT INTO relays(${frame}, host) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...framed(`relay-${host}`), host);
    database.prepare(`INSERT INTO watchers(${frame}, host) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...framed(`watcher-${host}`), host);
  }
  const region = database.prepare(
    `INSERT INTO regions(${frame}, hold, page_host, paths_json, environment_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  );
  region.run(
    ...framed("region-here"),
    "local",
    JSON.stringify({ local: "/Users/op/junto", mini: "/Users/mini/junto" }),
    JSON.stringify({
      sealed: true,
      sources: [
        { id: "everywhere", kind: "value", name: "MODE", value: "shared" },
        { id: "here", kind: "value", name: "HERE", value: "1", host: "local" },
        { id: "there", kind: "secret", name: "TOKEN", secretId: "token-1", host: "mini" },
      ],
      folders: ["~/shared"],
    }),
  );
  region.run(...framed("region-there"), "mini", JSON.stringify({ mini: "/Users/mini/junto" }), null);
  region.run(...framed("region-plain"), null, null, null);
  database
    .prepare(
      `INSERT INTO host_registry(id, label, kind, ssh_endpoint, ssh_identity_file, ssh_host_key_policy, capability_mask,
         hermes_id, effective_hermes_id, appearance_color, appearance_glyph, sort_order)
       VALUES ('mini', 'The mini', 'remote', 'op@mini.example', NULL, 'accept-new', 15, NULL, 'mini', NULL, NULL, 7)`,
    )
    .run();
  database
    .prepare("INSERT INTO station_status_facts(kind, host_id, record_json, updated_at) VALUES ('deployment', 'local', '{}', ?)")
    .run(at);
};

const hosts = (database: DatabaseSync, table: string) =>
  database.prepare(`SELECT id, host FROM ${table} WHERE id LIKE '%-local' OR id LIKE '%-mini' ORDER BY id`).all();

describe("state migration 20 -> 21 (machine names)", () => {
  it("freezes the version-twenty witness the step starts from and names the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V20_SQL)).toEqual(STATE_SCHEMA_V20_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V21_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(expectedStateSchemaIdentity(STATE_SCHEMA_SQL));
  });

  it.each(["command-center-v1.db", "remote-v1.db"])(
    "names this machine in every row of %s that said local, and keeps every other row",
    async (fixture) => {
      const database = await openCopy(fixture);
      try {
        migrateStateSchema(database, versionTwentyPlan);
        database.exec("PRAGMA foreign_keys = OFF");
        seed(database);
        database.exec("PRAGMA foreign_keys = ON");
        const before = snapshot(database);
        const name = machineNameAtMigration(database, "macbook");
        const configured = database.prepare("SELECT supervised_preferred, configured_at FROM station_configuration").get();

        const result = migrateStateSchema(database, namedPlan("macbook"));
        expect(result).toMatchObject({ previousVersion: 20, schemaVersion: 21 });
        expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(STATE_SCHEMA_V21_IDENTITY);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        const after = snapshot(database);
        expect(untouched(after)).toEqual(untouched(before));

        // The identity tables keep their rows under their plain names.
        expect(after.known_installations).toEqual(before.station_known_installations);
        expect(after.installation).toEqual(before.station_installation);
        expect(tables(database).filter((table) => table.startsWith("station_"))).toEqual(["station_status_facts"]);
        // Nothing stored still refers to a table by a name it no longer has.
        expect(
          database
            .prepare(
              `SELECT name FROM sqlite_schema
                WHERE sql LIKE '%station_known_installations%' OR sql LIKE '%station_installation%'
                   OR sql LIKE '%station_configuration%' OR sql LIKE '%station_fleet_targets%'`,
            )
            .all(),
        ).toEqual([]);
        // A row of the log still needs a machine this one knows.
        expect(() =>
          database
            .prepare(
              "INSERT INTO work_exchange_cursors(canvas_name, writer, through, last_basis_seq, updated_at) VALUES ('factory', 'a-machine-nobody-knows', '0', 0, ?)",
            )
            .run(at),
        ).toThrow(/FOREIGN KEY/u);
        // The identity of a machine still cannot be rewritten.
        expect(() => database.prepare("UPDATE known_installations SET installation_id = installation_id || '-x'").run()).toThrow(
          /immutable/u,
        );

        // This machine has its name, and what was configured for it.
        expect(name).not.toBe("local");
        expect(database.prepare("SELECT * FROM machine_configuration").all()).toEqual([
          { singleton: 1, machine_name: name, ...configured },
        ]);
        // The machines the old list pinned are not carried: they are pinned again by setup.
        expect(after.machine_peers).toEqual([]);
        // The machine list has one row for this machine, and every other machine it had.
        expect(
          database.prepare("SELECT id, label, is_this_machine, ssh_endpoint, sort_order FROM host_registry ORDER BY is_this_machine DESC, id").all(),
        ).toEqual([
          expect.objectContaining({ id: name, is_this_machine: 1 }),
          ...before.host_registry!
            .filter((row) => row.kind === "remote" && row.id !== name)
            .map((row) => ({ id: row.id, label: row.label, is_this_machine: 0, ssh_endpoint: row.ssh_endpoint, sort_order: row.sort_order }))
            .sort((left, right) => String(left.id).localeCompare(String(right.id))),
        ]);
        expect(after.host_registry!.map((row) => row.id)).toContain("mini");

        // Every row that said local names this machine; a row that named the mini still does.
        for (const kind of ["seat", "terminal", "page", "cron", "relay", "watcher"]) {
          expect(hosts(database, `${kind}s`)).toEqual([
            { id: `${kind}-local`, host: name },
            { id: `${kind}-mini`, host: "mini" },
          ]);
        }
        // A seat's key is its own text and is not rewritten.
        expect(database.prepare("SELECT agent_key FROM seats WHERE id = 'seat-local'").get()).toEqual({ agent_key: "local:claude" });
        const regions = database
          .prepare("SELECT id, page_host, paths_json, environment_json FROM regions WHERE id LIKE 'region-%' ORDER BY id")
          .all()
          .map((row) => ({
            id: row.id,
            pageHost: row.page_host,
            paths: row.paths_json === null ? null : JSON.parse(String(row.paths_json)),
            environment: row.environment_json === null ? null : JSON.parse(String(row.environment_json)),
          }));
        expect(regions).toEqual([
          {
            id: "region-here",
            pageHost: name,
            paths: { [name]: "/Users/op/junto", mini: "/Users/mini/junto" },
            environment: {
              sealed: true,
              sources: [
                { id: "everywhere", kind: "value", name: "MODE", value: "shared" },
                { id: "here", kind: "value", name: "HERE", value: "1", host: name },
                { id: "there", kind: "secret", name: "TOKEN", secretId: "token-1", host: "mini" },
              ],
              folders: ["~/shared"],
            },
          },
          { id: "region-plain", pageHost: null, paths: null, environment: null },
          { id: "region-there", pageHost: "mini", paths: { mini: "/Users/mini/junto" }, environment: null },
        ]);
        // A region the step had nothing to say about keeps its exact bytes.
        const sameBytes = (id: string) =>
          expect(after.regions!.find((row) => row.id === id)).toEqual(before.regions!.find((row) => row.id === id));
        sameBytes("region-there");
        sameBytes("region-plain");
        expect(database.prepare("SELECT host_id FROM station_status_facts WHERE kind = 'deployment'").all()).toEqual([{ host_id: name }]);

        // No row names a machine by the old word.
        for (const [table, column] of [
          ["seats", "host"],
          ["terminals", "host"],
          ["pages", "host"],
          ["crons", "host"],
          ["relays", "host"],
          ["watchers", "host"],
          ["peers", "host"],
          ["regions", "page_host"],
          ["host_registry", "id"],
          ["scheduler_interval_state", "home_station"],
          ["scheduler_interval_firings", "home_station"],
          ["station_status_facts", "host_id"],
        ] as const) {
          expect(database.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = 'local'`).get()).toEqual({ n: 0 });
        }
        expect(database.prepare("SELECT count(*) AS n FROM regions WHERE paths_json LIKE '%\"local\"%' OR environment_json LIKE '%\"host\":\"local\"%'").get()).toEqual({ n: 0 });

        expect(migrateStateSchema(database, namedPlan("macbook"))).toMatchObject({ previousVersion: 21, initialized: false });
      } finally {
        database.close();
      }
    },
  );

  it("never takes the name of a machine it knows, and keeps a name it was already given", async () => {
    const database = await openCopy("command-center-v1.db");
    try {
      migrateStateSchema(database, versionTwentyPlan);
      database.exec("PRAGMA foreign_keys = OFF");
      seed(database);
      // The name first boot would give is already the mini's.
      expect(machineNameAtMigration(database, "mini")).toBe("mini-2");
      database.prepare("UPDATE station_configuration SET host_id = 'atelier'").run();
      expect(machineNameAtMigration(database, "mini")).toBe("atelier");
      database.exec("PRAGMA foreign_keys = ON");

      migrateStateSchema(database, namedPlan("mini"));
      expect(database.prepare("SELECT machine_name FROM machine_configuration").get()).toEqual({ machine_name: "atelier" });
      expect(database.prepare("SELECT id FROM host_registry WHERE is_this_machine = 1").get()).toEqual({ id: "atelier" });
      expect(hosts(database, "seats")).toEqual([
        { id: "seat-local", host: "atelier" },
        { id: "seat-mini", host: "mini" },
      ]);
      // The step and any later reader agree on the name.
      expect(machineNameAtMigration(database, "anything")).toBe("atelier");
    } finally {
      database.close();
    }
  });

  it("keeps the name the machine that set it up gave it, and is one row in its own list", async () => {
    const database = await openCopy("remote-v1.db");
    try {
      migrateStateSchema(database, versionTwentyPlan);
      database.exec("PRAGMA foreign_keys = OFF");
      seed(database);
      database.exec("PRAGMA foreign_keys = ON");
      // It was set up as `studio`, and its own list holds a row of that name.
      expect(database.prepare("SELECT role, host_id FROM station_configuration").get()).toEqual({ role: "remote", host_id: "studio" });
      expect(database.prepare("SELECT kind FROM host_registry WHERE id = 'studio'").get()).toEqual({ kind: "remote" });
      expect(machineNameAtMigration(database, "macbook")).toBe("studio");

      migrateStateSchema(database, namedPlan("macbook"));
      expect(database.prepare("SELECT id, is_this_machine FROM host_registry ORDER BY id").all()).toEqual([
        { id: "mini", is_this_machine: 0 },
        { id: "studio", is_this_machine: 1 },
      ]);
      expect(hosts(database, "seats")).toEqual([
        { id: "seat-local", host: "studio" },
        { id: "seat-mini", host: "mini" },
      ]);
    } finally {
      database.close();
    }
  });
});
