import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STATION_STATE_SCHEMA_SQL } from "../src/main/junto/station/state-schema";
import { migrateMachineConfiguration, migrateMachineIdentity, migrateMachinePeers } from "../src/main/junto/machines/migrate";

const open = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  database.exec(STATION_STATE_SCHEMA_SQL);
  return database;
};
const convert = (database: DatabaseSync, name: string): void => {
  database.exec("BEGIN");
  try {
    migrateMachineIdentity(database);
    migrateMachineConfiguration(database, name);
    migrateMachinePeers(database, name);
    database.exec("COMMIT");
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }
};

describe("machine configuration conversion", () => {
  it("preserves installation identity, peer pins and supervision while removing roles", () => {
    const database = open();
    try {
      database.exec(`
        INSERT INTO station_known_installations VALUES ('this-install', '2026-10-09'), ('mini-install', '2026-10-08');
        INSERT INTO station_installation VALUES (1, 'this-install', '2026-10-09');
        INSERT INTO station_configuration VALUES (1, 'command-center', 'local', NULL, NULL, 1, '2026-10-09');
        INSERT INTO station_fleet_targets VALUES ('mini', 'mini-install', '2026-10-08', NULL);
      `);
      convert(database, "macbook");
      expect(database.prepare("SELECT * FROM installation").get()).toEqual({ singleton: 1, installation_id: "this-install", created_at: "2026-10-09" });
      expect(database.prepare("SELECT * FROM machine_configuration").get()).toEqual({ singleton: 1, machine_name: "macbook", supervised_preferred: 1, configured_at: "2026-10-09" });
      expect(database.prepare("SELECT * FROM machine_peers").get()).toEqual({ machine_name: "mini", installation_id: "mini-install", bound_at: "2026-10-08", retired_at: null });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => database.exec("UPDATE installation SET installation_id = 'changed'")).toThrow("immutable");
      expect(() => database.exec("UPDATE machine_peers SET machine_name = 'changed'")).toThrow("immutable");
      expect(() => database.exec("UPDATE machine_peers SET installation_id = 'this-install'")).toThrow("immutable");
    } finally { database.close(); }
  });

  it("creates one persistent identity and named configuration on an empty installation", () => {
    const database = open();
    try {
      convert(database, "mini");
      const id = database.prepare("SELECT installation_id FROM installation").get()!.installation_id;
      expect(typeof id).toBe("string");
      expect(database.prepare("SELECT installation_id FROM known_installations").get()!.installation_id).toBe(id);
      expect(database.prepare("SELECT machine_name FROM machine_configuration").get()).toEqual({ machine_name: "mini" });
    } finally { database.close(); }
  });

  it("retains an inactive peer pin and the preexisting foreign-key relationships", () => {
    const database = open();
    try {
      database.exec(`
        INSERT INTO station_known_installations VALUES ('mini-install', 'yesterday');
        INSERT INTO station_fleet_targets VALUES ('mini', 'mini-install', 'yesterday', 'today');
        CREATE TABLE witness(id TEXT REFERENCES station_known_installations(installation_id)) STRICT;
        INSERT INTO witness VALUES ('mini-install');
      `);
      convert(database, "macbook");
      expect(database.prepare("SELECT retired_at FROM machine_peers").get()).toEqual({ retired_at: "today" });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_list(witness)").get()!.table).toBe("known_installations");
    } finally { database.close(); }
  });

  it("rolls the entire conversion back when the machine name cannot be stored", () => {
    const database = open();
    try {
      expect(() => convert(database, "local")).toThrow("real short name");
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'station_installation'").get()).toEqual({ name: "station_installation" });
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = 'installation'").get()).toBeUndefined();
    } finally { database.close(); }
  });
});
