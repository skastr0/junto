/**
 * Step 41 adds `task_seat_releases`: the open tasks a seat delete sent back
 * to the backlog, so undoing the delete gives each back to its seat. This
 * machine's own state, expand-only.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V40_IDENTITY,
  STATE_SCHEMA_V41_IDENTITY,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import { STATE_SCHEMA_V40_SQL, STATE_SCHEMA_V41_SQL } from "./fixtures/state-v13/schema";

describe("state step 40 to 41: the tasks a seat delete released", () => {
  it("starts from the version-40 witness and ends at the version-41 one, which is the head", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V40_SQL)).toEqual(STATE_SCHEMA_V40_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V41_SQL)).toEqual(STATE_SCHEMA_V41_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(STATE_SCHEMA_V41_IDENTITY);
    expect(CURRENT_STATE_SCHEMA_IDENTITY).toEqual(STATE_SCHEMA_V41_IDENTITY);
  });

  it("adds the release table, keyed by canvas, seat and task, and nothing else", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_V40_SQL);
      const tables = () => (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      const before = tables();
      STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 41)!.migrate(database);
      expect(tables().filter((name) => !before.includes(name))).toEqual(["task_seat_releases"]);
      const insert = database.prepare("INSERT INTO task_seat_releases (canvas_name, seat_node_id, task_id, released_head) VALUES (?, ?, ?, ?)");
      insert.run("factory", "ada", "01JZ0000000000000000000000", "{}");
      expect(() => insert.run("factory", "ada", "01JZ0000000000000000000000", "{}")).toThrow();
      expect(() => insert.run("factory", "bo", "01JZ0000000000000000000000", "not json")).toThrow();
    } finally {
      database.close();
    }
  });
});
