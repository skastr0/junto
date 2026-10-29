/**
 * The fleet consensus tables (0.11, 06 F6) hold only what the driver can
 * mean: a ruling entry carries its writer, op id, command and ruling, a
 * structure entry its count, a list entry its lists by position, and a
 * removed canvas takes all of it along. The seed is today's behaviour:
 * term 1, nothing committed, each canvas's editor its one authority.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLEET_CONSENSUS_SEED_SQL, FLEET_CONSENSUS_STATE_SCHEMA_SQL } from "../src/main/junto/fleet/state-schema";

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("CREATE TABLE installation (singleton INTEGER PRIMARY KEY, installation_id TEXT NOT NULL) STRICT");
  database.exec("INSERT INTO installation VALUES (1, 'macbook')");
  database.exec("CREATE TABLE canvases (canvas_name TEXT PRIMARY KEY, editor_installation_id TEXT) STRICT, WITHOUT ROWID");
  database.exec("INSERT INTO canvases VALUES ('factory', 'mini'), ('home', NULL)");
  database.exec(FLEET_CONSENSUS_STATE_SCHEMA_SQL);
  database.exec(FLEET_CONSENSUS_SEED_SQL);
});

afterEach(() => database.close());

const all = (sql: string) => database.prepare(sql).all().map((row) => ({ ...row }));
const OP = "01M62AT0000000000000000001";

const ruling = (index: number, overrides: Record<string, unknown> = {}) => {
  const row = { writer: "mini", op_id: OP, command_json: "{}", ruling_json: "{}", structure_seq: null, ...overrides };
  database
    .prepare("INSERT INTO canvas_log (canvas_name, log_index, term, kind, writer, op_id, command_json, ruling_json, structure_seq) VALUES ('factory', ?, 1, 'ruling', ?, ?, ?, ?, ?)")
    .run(index, row.writer as never, row.op_id as never, row.command_json as never, row.ruling_json as never, row.structure_seq as never);
};

describe("the fleet consensus tables", () => {
  it("seed every canvas at term 1 with its editor, or this machine where none is named", () => {
    expect(all("SELECT * FROM canvas_consensus ORDER BY canvas_name")).toEqual([
      { canvas_name: "factory", current_term: 1, voted_for: null, commit_index: 0, applied_index: 0, sole_installation_id: null, last_applied_at_epoch_ms: null },
      { canvas_name: "home", current_term: 1, voted_for: null, commit_index: 0, applied_index: 0, sole_installation_id: null, last_applied_at_epoch_ms: null },
    ]);
    expect(all("SELECT * FROM canvas_authorities ORDER BY canvas_name")).toEqual([
      { canvas_name: "factory", position: 0, installation_id: "mini" },
      { canvas_name: "home", position: 0, installation_id: "macbook" },
    ]);
    expect(all("SELECT * FROM canvas_log")).toEqual([]);
  });

  it("seeds again without a change", () => {
    database.exec("UPDATE canvas_consensus SET current_term = 4, commit_index = 2, applied_index = 2");
    database.exec(FLEET_CONSENSUS_SEED_SQL);
    expect(all("SELECT current_term, commit_index FROM canvas_consensus WHERE canvas_name = 'factory'")).toEqual([{ current_term: 4, commit_index: 2 }]);
    expect(all("SELECT COUNT(*) AS n FROM canvas_authorities")).toEqual([{ n: 2 }]);
  });

  it("hold a ruling entry only whole, and once per command", () => {
    ruling(1);
    expect(() => ruling(2)).toThrow(/UNIQUE/);
    expect(() => ruling(3, { op_id: "01M62AT0000000000000000003", command_json: null })).toThrow(/CHECK/);
    expect(() => ruling(4, { op_id: "01M62AT0000000000000000004", structure_seq: 7 })).toThrow(/CHECK/);
  });

  it("hold a structure entry with its count and nothing of a ruling", () => {
    database.prepare("INSERT INTO canvas_log (canvas_name, log_index, term, kind, structure_seq) VALUES ('factory', 1, 1, 'structure.changed', 9)").run();
    expect(() => database.prepare("INSERT INTO canvas_log (canvas_name, log_index, term, kind) VALUES ('factory', 2, 1, 'structure.changed')").run()).toThrow(/CHECK/);
    expect(() => database.prepare("INSERT INTO canvas_log (canvas_name, log_index, term, kind, writer) VALUES ('factory', 3, 1, 'noop', 'mini')").run()).toThrow(/CHECK/);
  });

  it("hold a list entry's lists by position, and drop them when the entry is truncated", () => {
    database.prepare("INSERT INTO canvas_log (canvas_name, log_index, term, kind) VALUES ('factory', 1, 1, 'list')").run();
    const member = database.prepare("INSERT INTO canvas_log_members VALUES ('factory', 1, ?, ?, ?)");
    member.run("old", 0, "mini");
    member.run("list", 0, "mini");
    member.run("list", 1, "macbook");
    expect(() => member.run("list", 2, "mini")).toThrow(/UNIQUE/);
    expect(() => database.prepare("INSERT INTO canvas_log (canvas_name, log_index, term, kind, sole_installation_id) VALUES ('factory', 2, 1, 'noop', 'mini')").run()).toThrow(/CHECK/);
    database.exec("DELETE FROM canvas_log WHERE canvas_name = 'factory' AND log_index >= 1");
    expect(all("SELECT * FROM canvas_log_members")).toEqual([]);
  });

  it("keep a revoked operator command whole until the operator acts", () => {
    const wait = database.prepare(
      "INSERT INTO canvas_log_waiting (canvas_name, log_index, term, kind, writer, op_id, command_json, structure_seq, revoked_at_epoch_ms) VALUES ('factory', ?, 3, ?, ?, ?, ?, ?, 0)",
    );
    wait.run(1, "ruling", "macbook", OP, "{}", null);
    wait.run(2, "structure.changed", null, null, null, 12);
    expect(() => wait.run(3, "ruling", "macbook", OP, null, null)).toThrow(/CHECK/);
    expect(() => wait.run(4, "noop", null, null, null, null)).toThrow(/CHECK/);
  });

  it("go with their canvas", () => {
    ruling(1);
    database.prepare("INSERT INTO canvas_log_waiting (canvas_name, log_index, term, kind, structure_seq, revoked_at_epoch_ms) VALUES ('factory', 1, 2, 'structure.changed', 3, 0)").run();
    database.exec("DELETE FROM canvases WHERE canvas_name = 'factory'");
    for (const table of ["canvas_consensus", "canvas_authorities", "canvas_log", "canvas_log_waiting"]) {
      expect(all(`SELECT canvas_name FROM ${table} WHERE canvas_name = 'factory'`), table).toEqual([]);
    }
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
