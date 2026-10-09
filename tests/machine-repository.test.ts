import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { InstallationId } from "../src/shared/installation-id";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { MACHINE_STATE_SCHEMA_SQL } from "../src/main/junto/machines/state-schema";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { MODEL_STATE_SCHEMA_SQL } from "../src/main/junto/model/state-schema";
import { MACHINE_REGISTRY_STATE_SCHEMA_SQL } from "../src/main/junto/hosts/state-schema";

const fixture = () => {
  const database = new DatabaseSync(":memory:");
  database.exec(MACHINE_STATE_SCHEMA_SQL + MODEL_STATE_SCHEMA_SQL + MACHINE_REGISTRY_STATE_SCHEMA_SQL);
  database.exec("INSERT INTO host_registry(id,label,is_this_machine,effective_hermes_id,sort_order) VALUES ('macbook','This Mac',1,'macbook',0)");
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const runtime = ManagedRuntime.make(makeMachineRepositoryLive({
    makeInstallationId: () => Schema.decodeUnknownSync(InstallationId)("this-install"),
    defaultName: () => "macbook", now: () => "2026-10-09",
  }).pipe(Layer.provideMerge(sql)));
  return { database, runtime, close: async () => { await runtime.dispose(); database.close(); } };
};
const peer = { machineName: "mini", installationId: Schema.decodeUnknownSync(InstallationId)("mini-install") };

describe("machine repository", () => {
  it("persists one identity and a configured name", async () => {
    const f = fixture();
    try {
      const repository = await f.runtime.runPromise(MachineRepository);
      expect(await f.runtime.runPromise(repository.installationId)).toBe("this-install");
      expect(await f.runtime.runPromise(repository.machineName)).toBe("macbook");
      expect(f.database.prepare("SELECT installation_id FROM known_installations").all()).toEqual([{ installation_id: "this-install" }]);
    } finally { await f.close(); }
  });

  it("pins a route-free peer idempotently and preserves its first binding date", async () => {
    const f = fixture();
    try {
      const repository = await f.runtime.runPromise(MachineRepository);
      const first = await f.runtime.runPromise(repository.pinPeer(peer));
      expect(await f.runtime.runPromise(repository.pinPeer(peer))).toEqual(first);
      expect(await f.runtime.runPromise(repository.peer("mini"))).toEqual(first);
      expect(await f.runtime.runPromise(repository.peers)).toEqual([first]);
      expect(f.database.prepare("SELECT COUNT(*) AS count FROM machine_peers").get()).toEqual({ count: 1 });
    } finally { await f.close(); }
  });

  it("refuses identity or name changes without registering the rejected identity", async () => {
    const f = fixture();
    try {
      const repository = await f.runtime.runPromise(MachineRepository);
      await f.runtime.runPromise(repository.pinPeer(peer));
      const changed = Schema.decodeUnknownSync(InstallationId)("changed-install");
      await expect(f.runtime.runPromise(repository.pinPeer({ ...peer, installationId: changed }))).rejects.toThrow("pinned to another installation");
      await expect(f.runtime.runPromise(repository.pinPeer({ ...peer, machineName: "changed" }))).rejects.toThrow("pinned to another machine name");
      expect(f.database.prepare("SELECT installation_id FROM known_installations WHERE installation_id = ?").get(changed)).toBeUndefined();
      expect(await f.runtime.runPromise(repository.peers)).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("refuses self pins and malformed names before any peer mutation", async () => {
    const f = fixture();
    try {
      const repository = await f.runtime.runPromise(MachineRepository);
      for (const input of [
        { ...peer, installationId: Schema.decodeUnknownSync(InstallationId)("this-install") },
        { ...peer, machineName: "macbook" }, { ...peer, machineName: "local" },
      ]) await expect(f.runtime.runPromise(repository.pinPeer(input))).rejects.toThrow();
      expect(await f.runtime.runPromise(repository.peers)).toEqual([]);
    } finally { await f.close(); }
  });

  it("keeps retired pins immutable and revives only the exact setup identity", async () => {
    const f = fixture();
    try {
      const repository = await f.runtime.runPromise(MachineRepository);
      const first = await f.runtime.runPromise(repository.pinPeer(peer));
      await f.runtime.runPromise(repository.retirePeer("mini"));
      expect(await f.runtime.runPromise(repository.peer("mini"))).toBeUndefined();
      await expect(f.runtime.runPromise(repository.pinPeer({ ...peer, installationId: Schema.decodeUnknownSync(InstallationId)("new-install") }))).rejects.toThrow();
      expect(await f.runtime.runPromise(repository.pinPeer(peer))).toEqual(first);
    } finally { await f.close(); }
  });

  it("joins a caller's transaction so a failed setup leaves no pin or known id", async () => {
    const f = fixture();
    try {
      await f.runtime.runPromise(Effect.gen(function* () {
        const repository = yield* MachineRepository;
        const sql = yield* SqlClient.SqlClient;
        const result = yield* Effect.result(sql.withTransaction(repository.pinPeer(peer).pipe(Effect.andThen(Effect.fail("rollback")))));
        expect(result._tag).toBe("Failure");
        expect(yield* repository.peer("mini")).toBeUndefined();
        expect(yield* sql`SELECT installation_id FROM known_installations WHERE installation_id = ${peer.installationId}`).toEqual([]);
      }));
    } finally { await f.close(); }
  });

  it("names a fresh machine atomically and preserves its identity and presentation", async () => {
    const f = fixture();
    try {
      const repository = await f.runtime.runPromise(MachineRepository);
      await f.runtime.runPromise(repository.configureName("studio"));
      expect(await f.runtime.runPromise(repository.machineName)).toBe("studio");
      expect(await f.runtime.runPromise(repository.installationId)).toBe("this-install");
      expect(f.database.prepare("SELECT id,label,effective_hermes_id FROM host_registry").get()).toEqual({ id: "studio", label: "This Mac", effective_hermes_id: "studio" });
    } finally { await f.close(); }
  });

  it("keeps an explicit Hermes alias when a fresh machine is named", async () => {
    const f = fixture();
    try {
      const repository = await f.runtime.runPromise(MachineRepository);
      f.database.exec("UPDATE host_registry SET hermes_id = 'profiles', effective_hermes_id = 'profiles'");
      await f.runtime.runPromise(repository.configureName("studio"));
      expect(f.database.prepare("SELECT id,hermes_id,effective_hermes_id FROM host_registry").get()).toEqual({ id: "studio", hermes_id: "profiles", effective_hermes_id: "profiles" });
    } finally { await f.close(); }
  });

  it.each([false, true])("refuses a new own name after a peer was pinned, retired=%s", async (retired) => {
    const f = fixture();
    try {
      const repository = await f.runtime.runPromise(MachineRepository);
      await f.runtime.runPromise(repository.pinPeer(peer));
      if (retired) await f.runtime.runPromise(repository.retirePeer(peer.machineName));
      await expect(f.runtime.runPromise(repository.configureName("studio"))).rejects.toThrow("a peer has been pinned");
      expect(await f.runtime.runPromise(repository.machineName)).toBe("macbook");
      expect(f.database.prepare("SELECT id FROM host_registry WHERE is_this_machine=1").get()).toEqual({ id: "macbook" });
    } finally { await f.close(); }
  });

  it.each(["macbook", "studio"])("refuses renaming over stored placement %s", async (host) => {
    const f = fixture();
    try {
      const repository = await f.runtime.runPromise(MachineRepository);
      f.database.exec("INSERT INTO canvases(canvas_name,canvas_id,created_at,updated_at) VALUES ('canvas','canvas-id','now','now')");
      f.database.prepare("INSERT INTO pages(canvas_name,id,x,y,width,height,z_index,created_at,updated_at,url,host,profile,on_remove) VALUES ('canvas','page',0,0,100,100,0,'now','now','https://example.test',?,'default','detach')").run(host);
      await expect(f.runtime.runPromise(repository.configureName("studio"))).rejects.toThrow("a stored row uses it");
      expect(await f.runtime.runPromise(repository.machineName)).toBe("macbook");
    } finally { await f.close(); }
  });

  it("rolls back configuration when the selected name collides with another registered machine", async () => {
    const f = fixture();
    try {
      const repository = await f.runtime.runPromise(MachineRepository);
      f.database.exec("INSERT INTO host_registry(id,label,is_this_machine,capability_mask,sort_order) VALUES ('studio','Another machine',0,1,1)");
      await expect(f.runtime.runPromise(repository.configureName("studio"))).rejects.toThrow();
      expect(await f.runtime.runPromise(repository.machineName)).toBe("macbook");
      expect(f.database.prepare("SELECT id FROM host_registry WHERE is_this_machine=1").get()).toEqual({ id: "macbook" });
    } finally { await f.close(); }
  });
});
