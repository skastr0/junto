import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { MASKED_SECRET } from "../src/shared/settings";
import { makeSettingsService } from "../src/main/vellum-command/settings/service";
import { makeStateEngineLive, StateEngine } from "../src/main/vellum-command/state/engine";
import { MemoryCredentialStore } from "../src/main/vellum-command/credentials/store";
import { PROVIDER_CREDENTIAL_SLOT_VALUES } from "../src/main/vellum-command/credentials/state-schema";

const SECRET = "sk-proof-plaintext-credential-9f8e7d6c-UNIQUE";
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("provider credential vault", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("keeps secrets out of SQLite and newly minted backups", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-cred-vault-"));
    const databasePath = join(root, "state", "vellum-command.db");
    const runtime = ManagedRuntime.make(makeStateEngineLive(databasePath));
    const state = await runtime.runPromise(StateEngine);
    const store = new MemoryCredentialStore();
    const service = await run(makeSettingsService(state, { credentials: store }));

    const patched = await run(
      service.patch({ providers: { openrouter: { apiKey: SECRET } } }),
    );
    expect(patched.providers?.openrouter?.apiKey).toBe(MASKED_SECRET);
    expect(await run(service.resolveProviders)).toEqual({
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
    expect(await run(service.resolveProviders)).toEqual({});

    await runtime.dispose();
  });

  it("strips leftover plaintext from newly minted backups", async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-cred-backup-redact-"));
    const databasePath = join(root, "state", "vellum-command.db");
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

  it("declares every provider secret slot in schema 22", () => {
    expect(PROVIDER_CREDENTIAL_SLOT_VALUES).toContain("openrouter/apiKey");
    expect(PROVIDER_CREDENTIAL_SLOT_VALUES).toHaveLength(11);
  });
});
