/**
 * Step 44 adds `automation_ruling_cursors`: how far the automation runner has
 * read each canvas's task rulings, as the `work_events` seq of the last one.
 * Local to the editing machine. Expand-only.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V43_IDENTITY,
  STATE_SCHEMA_V44_IDENTITY,
} from "../src/main/junto/state/migrations";
import { expectedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { STATE_SCHEMA_V43_SQL, STATE_SCHEMA_V44_SQL } from "./fixtures/state-v13/schema";

describe("state step 43 to 44: the automation ruling cursors", () => {
  it("starts from the version-43 witness and ends at the version-44 one", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V43_SQL)).toEqual(STATE_SCHEMA_V43_IDENTITY);
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V44_SQL)).toEqual(STATE_SCHEMA_V44_IDENTITY);
  });

  it("adds the cursor table, one decimal seq per canvas, and nothing else", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_V43_SQL);
      const tables = () => (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      const before = tables();
      STATE_SCHEMA_MIGRATIONS.find((step) => step.toVersion === 44)!.migrate(database);
      expect(tables().filter((name) => !before.includes(name))).toEqual(["automation_ruling_cursors"]);
      const insert = database.prepare("INSERT INTO automation_ruling_cursors (canvas_name, seq) VALUES (?, ?)");
      insert.run("factory", "0");
      expect(() => insert.run("factory", "12")).toThrow();
      expect(() => insert.run("studio", "1a")).toThrow();
      expect(() => insert.run("studio", "")).toThrow();
    } finally {
      database.close();
    }
  });
});
