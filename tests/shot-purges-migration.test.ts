/**
 * Step 42 adds `content_purges`: the page comments whose shot the operator
 * purged, keyed by canvas, page node and comment, with no digest. Each
 * machine keeps its own; the purge crosses as a `shot.purged` row, so no
 * exchange, copy or link code reads this table. Expand-only.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V41_IDENTITY,
  STATE_SCHEMA_V42_IDENTITY,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V41_SQL, STATE_SCHEMA_V42_SQL } from "./fixtures/state-v13/schema";

describe("state step 41 to 42: the purged page comment shots", () => {
  it("starts from the version-41 witness and ends at the version-42 one, which is the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V41_SQL)).toEqual(STATE_SCHEMA_V41_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V42_SQL)).toEqual(STATE_SCHEMA_V42_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V42_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V42_IDENTITY);
  });

  it("adds the purge table, keyed by canvas, page node and comment, and nothing else", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_V41_SQL);
      const tables = () => (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      const before = tables();
      STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 42)!.migrate(database);
      expect(tables().filter((name) => !before.includes(name))).toEqual(["content_purges"]);
      const insert = database.prepare("INSERT INTO content_purges (canvas_name, node_id, record_id, purged_at) VALUES (?, ?, ?, ?)");
      insert.run("factory", "page-1", "msg-1", "2026-10-21T12:00:00.000Z");
      expect(() => insert.run("factory", "page-1", "msg-1", "2026-10-21T12:00:01.000Z")).toThrow();
      expect(() => insert.run("factory", "page-1", "", "2026-10-21T12:00:00.000Z")).toThrow();
    } finally {
      database.close();
    }
  });

  it("is named by no exchange, copy or link code: a purge crosses as its own row, never as this table", () => {
    const files = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".ts")).map((name) => join(dir, name));
    const sources = [
      ...files("src/main/junto/work/exchange"),
      ...files("src/main/junto/link"),
      "src/shared/canvas-copy.ts",
      "src/shared/work-exchange.ts",
    ];
    expect(sources.filter((file) => readFileSync(file, "utf8").includes("content_purges"))).toEqual([]);
  });
});
