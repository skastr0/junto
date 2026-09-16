import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { MASKED_SECRET } from "../src/shared/settings";
import { makeSettingsService } from "../src/main/junto/settings/service";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import {
  MemoryCredentialStore,
  UnavailableCredentialStore,
} from "../src/main/junto/credentials/store";
import { PROVIDER_CREDENTIAL_SLOT_VALUES } from "../src/main/junto/credentials/state-schema";
import { reconcilePendingStateBackups } from "../src/main/junto/state/backup";

const SECRET = "sk-proof-plaintext-credential-9f8e7d6c-UNIQUE";
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("provider credential vault", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("keeps secrets out of SQLite and newly minted backups", async () => {
    root = await mkdtemp(join(tmpdir(), "junto-cred-vault-"));
    const databasePath = join(root, "state", "junto.db");
    const runtime = ManagedRuntime.make(makeStateEngineLive(databasePath));
    const state = await runtime.runPromise(StateEngine);
    const store = new MemoryCredentialStore();
    const service = await run(makeSettingsService(state, { credentials: store }));

    const patched = await run(
      service.patch({ providers: { openrouter: { apiKey: SECRET } } }),
    );
    expect(patched.providers?.openrouter?.apiKey).toBe(MASKED_SECRET);
    expect(await run(service.resolveProviders)).toEqual({
      enabledSources: [],
      openrouter: { apiKey: SECRET },
    });

    const liveBody = await run(
      state.read("proof.live", (reader) =>
        String(
          reader.get<{ body: string }>(
            "SELECT body FROM settings_preferences WHERE singleton = 1",
          )?.body ?? "",
        ),
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

  it("strips leftover plaintext from newly minted backups", async () => {
    root = await mkdtemp(join(tmpdir(), "junto-cred-backup-redact-"));
    const databasePath = join(root, "state", "junto.db");
    const runtime = ManagedRuntime.make(makeStateEngineLive(databasePath));
    const state = await runtime.runPromise(StateEngine);
    await run(makeSettingsService(state, { credentials: new MemoryCredentialStore() }));
    await run(
      state.transaction("seed-plaintext", (writer) => {
        const row = writer.get<{ body: string }>(
          "SELECT body FROM settings_preferences WHERE singleton = 1",
        );
        const body = JSON.parse(String(row?.body ?? "{}")) as Record<string, unknown>;
        writer.run(
          `UPDATE settings_preferences SET body = ? WHERE singleton = 1`,
          [
            JSON.stringify({
              ...body,
              providers: { openrouter: { apiKey: SECRET } },
            }),
          ],
        );
      }),
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
    const runtime = ManagedRuntime.make(makeStateEngineLive(databasePath));
    const state = await runtime.runPromise(StateEngine);
    await run(makeSettingsService(state, { credentials: new MemoryCredentialStore() }));
    await run(
      state.transaction("seed-plaintext", (writer) => {
        const row = writer.get<{ body: string }>(
          "SELECT body FROM settings_preferences WHERE singleton = 1",
        );
        const body = JSON.parse(String(row?.body ?? "{}")) as Record<string, unknown>;
        writer.run(
          `UPDATE settings_preferences SET body = ? WHERE singleton = 1`,
          [
            JSON.stringify({
              ...body,
              providers: { openrouter: { apiKey: SECRET } },
            }),
          ],
        );
      }),
    );
    const service = await run(
      makeSettingsService(state, { credentials: new UnavailableCredentialStore() }),
    );
    await run(service.patch({ appearance: { reduceMotion: true } }));
    const liveBody = await run(
      state.read("proof.retained", (reader) =>
        String(
          reader.get<{ body: string }>(
            "SELECT body FROM settings_preferences WHERE singleton = 1",
          )?.body ?? "",
        ),
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
    const runtime = ManagedRuntime.make(makeStateEngineLive(databasePath));
    const state = await runtime.runPromise(StateEngine);
    await writeFile(join(root, "state", "credentials"), "not-a-directory");
    const service = await run(makeSettingsService(state));
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
