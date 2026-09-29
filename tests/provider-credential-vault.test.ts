import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { MASKED_SECRET } from "../src/shared/settings";
import { makeSettingsService } from "../src/main/junto/settings/service";
import { CredentialBindingRepository, CredentialPersistenceError } from "../src/main/junto/credentials/bindings";
import { StationConfigurationRepository } from "../src/main/junto/station/configuration-state";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import { StateTransactionOperation } from "../src/main/junto/state/service";
import {
  MemoryCredentialStore,
  UnavailableCredentialStore,
} from "../src/main/junto/credentials/store";
import { PROVIDER_CREDENTIAL_SLOT_VALUES } from "../src/main/junto/credentials/state-schema";
import { reconcilePendingStateBackups } from "../src/main/junto/state/backup";

const SECRET = "sk-proof-plaintext-credential-9f8e7d6c-UNIQUE";
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const makeRuntime = (path: string) => ManagedRuntime.make(
  Layer.mergeAll(CredentialBindingRepository.layer, StationConfigurationRepository.layer).pipe(
    Layer.provideMerge(makeStateEngineLive(path)),
  ),
);

describe("provider credential vault", () => {
  let root = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("keeps secrets out of SQLite and newly minted backups", async () => {
    root = await mkdtemp(join(tmpdir(), "junto-cred-vault-"));
    const databasePath = join(root, "state", "junto.db");
    const runtime = makeRuntime(databasePath);
    const state = await runtime.runPromise(StateEngine);
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    const store = new MemoryCredentialStore();
    const service = await runtime.runPromise(makeSettingsService(databasePath, { credentials: store }));

    const patched = await run(
      service.patch({ providers: { openrouter: { apiKey: SECRET } } }),
    );
    expect(patched.providers?.openrouter?.apiKey).toBe(MASKED_SECRET);
    expect(await run(service.resolveProviders)).toEqual({
      enabledSources: [],
      openrouter: { apiKey: SECRET },
    });

    const liveBody = await run(
      sql<{ body: string }>`SELECT body FROM settings_preferences WHERE singleton = 1`.pipe(
        Effect.map((rows) => String(rows[0]?.body ?? "")),
      ),
    );
    expect(liveBody.includes(SECRET)).toBe(false);

    const receipt = await run(state.backup());
    const backupBytes = await readFile(receipt.path);
    expect(backupBytes.includes(Buffer.from(SECRET))).toBe(false);
    const backupDb = new DatabaseSync(receipt.path, { readOnly: true });
    const backupBody = String(
      backupDb
        .prepare("SELECT body FROM settings_preferences WHERE singleton = 1")
        .get()?.body ?? "",
    );
    backupDb.close();
    expect(backupBody.includes(SECRET)).toBe(false);

    const cleared = await run(
      service.patch({ providers: { openrouter: { apiKey: "" } } }),
    );
    expect(cleared.providers?.openrouter).toBeUndefined();
    expect(await run(service.resolveProviders)).toEqual({
      enabledSources: [],
    });

    await runtime.dispose();
  });

  it("returns a typed staging failure and discards every unbound vault item", async () => {
    root = await mkdtemp(join(tmpdir(), "junto-cred-stage-failure-"));
    const databasePath = join(root, "junto.db");
    const runtime = makeRuntime(databasePath);
    try {
      const store = new MemoryCredentialStore();
      const bindings = await runtime.runPromise(CredentialBindingRepository);
      const service = await runtime.runPromise(makeSettingsService(databasePath, { credentials: store }));
      const before = await run(service.get);
      const published = vi.fn();
      service.subscribe(published);
      const put = store.put.bind(store);
      const writes: string[] = [];
      vi.spyOn(store, "put").mockImplementation((id, value) => {
        put(id, value);
        writes.push(id);
        if (writes.length === 2) throw new Error("vault full");
      });

      const result = await run(Effect.result(service.patch({ providers: {
        openrouter: { apiKey: SECRET },
        synthetic: { apiKey: "second-secret" },
      } })));

      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SettingsError", code: "io" } });
      expect(writes).toHaveLength(2);
      expect(store.listIds()).toEqual([]);
      expect(await run(bindings.list)).toEqual([]);
      expect(await run(service.get)).toEqual(before);
      expect(published).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("rolls back binding replacement and discards staged secrets on a participant failure", async () => {
    root = await mkdtemp(join(tmpdir(), "junto-cred-rollback-"));
    const databasePath = join(root, "junto.db");
    const runtime = makeRuntime(databasePath);
    try {
      const store = new MemoryCredentialStore();
      const bindings = await runtime.runPromise(CredentialBindingRepository);
      const service = await runtime.runPromise(makeSettingsService(databasePath, { credentials: store }));
      await run(service.patch({ providers: { openrouter: { apiKey: SECRET } } }));
      const before = await run(bindings.list);
      const oldIds = store.listIds();
      const published = vi.fn();
      service.subscribe(published);
      const insert = bindings.insert;
      vi.spyOn(bindings, "insert").mockImplementation((binding) => insert(binding).pipe(
        Effect.andThen(Effect.fail(new CredentialPersistenceError({
          operation: "insert",
          message: "participant failed after insert",
          cause: undefined,
        }))),
      ));

      const result = await run(Effect.result(service.patch({ providers: {
        openrouter: { apiKey: "replacement-secret" },
      } })));

      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SettingsError", code: "io" } });
      expect(await run(bindings.list)).toEqual(before);
      expect(store.listIds()).toEqual(oldIds);
      expect((await run(service.resolveProviders)).openrouter?.apiKey).toBe(SECRET);
      expect(published).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("stages before commit, retires afterward, and retries failed retirement at boot", async () => {
    root = await mkdtemp(join(tmpdir(), "junto-cred-retirement-"));
    const databasePath = join(root, "junto.db");
    const runtime = makeRuntime(databasePath);
    try {
      const store = new MemoryCredentialStore();
      const sql = await runtime.runPromise(SqlClient.SqlClient);
      const bindings = await runtime.runPromise(CredentialBindingRepository);
      const service = await runtime.runPromise(makeSettingsService(databasePath, { credentials: store }));
      await run(service.patch({ providers: { openrouter: { apiKey: SECRET } } }));
      const oldId = store.listIds()[0]!;
      const order: string[] = [];
      const put = store.put.bind(store);
      vi.spyOn(store, "put").mockImplementation((id, value) => {
        order.push("stage");
        put(id, value);
      });
      const withTransaction = sql.withTransaction;
      vi.spyOn(sql, "withTransaction").mockImplementation((body) => Effect.gen(function* () {
        const operation = yield* StateTransactionOperation;
        if (operation === "settings.patch") order.push("begin");
        const result = yield* withTransaction(body);
        if (operation === "settings.patch") order.push("commit");
        return result;
      }));
      const deletion = vi.spyOn(store, "delete").mockImplementation(() => {
        order.push("retire");
        throw new Error("vault deletion unavailable");
      });
      service.subscribe(() => order.push("publish"));

      await run(service.patch({ providers: { openrouter: { apiKey: "replacement-secret" } } }));

      expect(order).toEqual(["stage", "begin", "commit", "retire", "publish"]);
      expect(await run(bindings.list)).toMatchObject([
        { credentialId: oldId, lifecycle: "delete_pending" },
        { lifecycle: "active", slot: "openrouter/apiKey" },
      ]);
      expect(store.get(oldId)).toBe(SECRET);
      expect((await run(service.resolveProviders)).openrouter?.apiKey).toBe("replacement-secret");

      deletion.mockRestore();
      await runtime.runPromise(makeSettingsService(databasePath, { credentials: store }));
      expect(store.get(oldId)).toBeUndefined();
      expect(await run(bindings.list)).toMatchObject([{ lifecycle: "active", slot: "openrouter/apiKey" }]);
      expect(store.listIds()).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("strips leftover plaintext from newly minted backups", async () => {
    root = await mkdtemp(join(tmpdir(), "junto-cred-backup-redact-"));
    const databasePath = join(root, "state", "junto.db");
    const runtime = makeRuntime(databasePath);
    const state = await runtime.runPromise(StateEngine);
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(makeSettingsService(databasePath, { credentials: new MemoryCredentialStore() }));
    await run(
      sql.withTransaction(Effect.gen(function* () {
        const rows = yield* sql<{ body: string }>`SELECT body FROM settings_preferences WHERE singleton = 1`;
        const body = JSON.parse(String(rows[0]?.body ?? "{}")) as Record<string, unknown>;
        yield* sql`UPDATE settings_preferences SET body = ${JSON.stringify({
          ...body,
          providers: { openrouter: { apiKey: SECRET } },
        })} WHERE singleton = 1`;
      })),
    );
    const receipt = await run(state.backup());
    expect((await readFile(receipt.path)).includes(Buffer.from(SECRET))).toBe(
      false,
    );
    await runtime.dispose();
  });

  it("keeps unmigrated secrets across unrelated patches when the vault is unavailable", async () => {
    root = await mkdtemp(join(tmpdir(), "junto-cred-retain-"));
    const databasePath = join(root, "state", "junto.db");
    const runtime = makeRuntime(databasePath);
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(makeSettingsService(databasePath, { credentials: new MemoryCredentialStore() }));
    await run(
      sql.withTransaction(Effect.gen(function* () {
        const rows = yield* sql<{ body: string }>`SELECT body FROM settings_preferences WHERE singleton = 1`;
        const body = JSON.parse(String(rows[0]?.body ?? "{}")) as Record<string, unknown>;
        yield* sql`UPDATE settings_preferences SET body = ${JSON.stringify({
          ...body,
          providers: { openrouter: { apiKey: SECRET } },
        })} WHERE singleton = 1`;
      })),
    );
    const service = await runtime.runPromise(
      makeSettingsService(databasePath, { credentials: new UnavailableCredentialStore() }),
    );
    await run(service.patch({ appearance: { reduceMotion: true } }));
    const liveBody = await run(
      sql<{ body: string }>`SELECT body FROM settings_preferences WHERE singleton = 1`.pipe(
        Effect.map((rows) => String(rows[0]?.body ?? "")),
      ),
    );
    expect(liveBody.includes(SECRET)).toBe(true);
    expect(await run(service.resolveProviders)).toEqual({
      enabledSources: [],
      openrouter: { apiKey: SECRET },
    });
    const refused = await run(
      Effect.result(
        service.patch({ providers: { synthetic: { apiKey: "new-secret" } } }),
      ),
    );
    expect(refused._tag).toBe("Failure");
    await runtime.dispose();
  });

  it("boots when the credential vault cannot be created", async () => {
    root = await mkdtemp(join(tmpdir(), "junto-cred-boot-"));
    const databasePath = join(root, "state", "junto.db");
    const runtime = makeRuntime(databasePath);
    await runtime.runPromise(StateEngine);
    await writeFile(join(root, "state", "credentials"), "not-a-directory");
    const service = await runtime.runPromise(makeSettingsService(databasePath));
    const settings = await run(service.get);
    expect(settings.appearance.theme).toBeDefined();
    await runtime.dispose();
  });

  it("removes pending backup databases and sqlite sidecars", async () => {
    root = await mkdtemp(join(tmpdir(), "junto-pending-backup-"));
    const backups = join(root, "backups");
    await mkdir(backups, { mode: 0o700 });
    const finalName =
      "junto-backup-22222222-2222-4222-8222-222222222222.db";
    const pendingName =
      "junto-backup-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.db.pending";
    await writeFile(join(backups, pendingName), SECRET, { mode: 0o600 });
    await writeFile(join(backups, `${pendingName}-journal`), SECRET, { mode: 0o600 });
    await writeFile(join(backups, finalName), "keep", { mode: 0o600 });
    reconcilePendingStateBackups(root);
    expect(await readdir(backups)).toEqual([finalName]);
  });

  it("declares every provider secret slot in schema 22", () => {
    expect(PROVIDER_CREDENTIAL_SLOT_VALUES).toContain("openrouter/apiKey");
    expect(PROVIDER_CREDENTIAL_SLOT_VALUES).toHaveLength(11);
  });
});
