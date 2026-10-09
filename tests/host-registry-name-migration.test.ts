import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { HOSTS_STATE_SCHEMA_SQL } from "../src/main/junto/hosts/state-schema";
import { migrateHostRegistry } from "../src/main/junto/hosts/migrate";

const open = () => {
  const database = new DatabaseSync(":memory:");
  database.exec(HOSTS_STATE_SCHEMA_SQL);
  return database;
};
const local = (database: DatabaseSync) => database.exec("INSERT INTO host_registry(id,label,kind,capability_mask,effective_hermes_id,sort_order) VALUES('local','local','local',NULL,'local',0)");

describe("host registry name conversion", () => {
  it("preserves routes, presentation and opaque Hermes aliases while naming this machine", () => {
    const database = open();
    try {
      local(database);
      database.exec("INSERT INTO host_registry(id,label,kind,ssh_endpoint,ssh_identity_file,ssh_host_key_policy,capability_mask,hermes_id,effective_hermes_id,appearance_color,appearance_glyph,sort_order) VALUES('studio','Studio','remote','user@studio','/Users/me/.ssh/key','accept-new',9,'studio-alias','studio-alias','amber','S',1)");
      const before = database.prepare("SELECT * FROM host_registry WHERE id='studio'").get()!;
      delete before.kind;
      database.exec("BEGIN"); migrateHostRegistry(database, "macbook"); database.exec("COMMIT");
      const after = database.prepare("SELECT * FROM host_registry WHERE id='studio'").get()!;
      expect(after).toEqual({ ...before, is_this_machine: 0, junto_home: null, install_root: null });
      expect(database.prepare("SELECT id,hermes_id FROM host_registry WHERE is_this_machine=1").get()).toEqual({ id: "macbook", hermes_id: "local" });
      expect(() => database.exec("DELETE FROM host_registry WHERE is_this_machine=1")).toThrow();
      expect(() => database.exec("UPDATE host_registry SET is_this_machine=0 WHERE is_this_machine=1")).toThrow();
      expect(() => database.exec("UPDATE host_registry SET junto_home='/tmp/other' WHERE is_this_machine=1")).toThrow();
      expect(() => database.exec("UPDATE host_registry SET install_root='relative' WHERE id='studio'")).toThrow();
      expect(database.prepare("PRAGMA table_info(host_registry)").all().some(row => row.name === "installation_id")).toBe(false);
    } finally { database.close(); }
  });

  it("seeds one named row and registry initialization on an empty database", () => {
    const database = open();
    try {
      database.exec("BEGIN"); migrateHostRegistry(database, "mini"); database.exec("COMMIT");
      expect(database.prepare("SELECT id,is_this_machine FROM host_registry").all()).toEqual([{ id: "mini", is_this_machine: 1 }]);
      expect(database.prepare("SELECT singleton FROM host_registry_state").get()).toEqual({ singleton: 1 });
    } finally { database.close(); }
  });

  it("refuses a name collision before replacing any stored rows", () => {
    const database = open();
    try {
      local(database);
      database.exec("INSERT INTO host_registry(id,label,kind,capability_mask,sort_order) VALUES('collision','Collision','remote',1,1)");
      database.exec("BEGIN");
      expect(() => migrateHostRegistry(database, "collision")).toThrow("conflicts");
      database.exec("ROLLBACK");
      expect(database.prepare("SELECT id FROM host_registry WHERE kind='local'").get()).toEqual({ id: "local" });
    } finally { database.close(); }
  });
});
