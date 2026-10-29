/**
 * The vault contract (docs/machines.md, The vault): a vault name that can
 * never widen the mint's `--vault` argument, a region whose 1Password
 * references point into its vault, this machine's token as a 0600 file the
 * scrub knows, and its scope record as a row of names only.
 */
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { RegionEnvironment } from "../src/shared/model/region";
import { isRefInVault, VaultName, vaultOfRef } from "../src/shared/vault";
import { scrubMessage } from "../src/main/junto/credentials/scrub";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { VaultTokens, VaultTokensLive } from "../src/main/junto/vault/repository";
import { readVaultToken, removeVaultToken, vaultDir, writeVaultToken } from "../src/main/junto/vault/token-file";

const TOKEN = "ops_test-only-vault-token-abcdefghijklmnop0123";

let home: string | undefined;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});
const freshHome = async () => (home = await mkdtemp(join(tmpdir(), "junto-vault-")));

describe("the vault name", () => {
  it("refuses what would widen --vault <name>:<permissions> or split an op:// reference", () => {
    const valid = Schema.is(VaultName);
    for (const name of ["Junto", "Junto Secrets", "dev-1", "Équipe"]) expect(valid(name), name).toBe(true);
    for (const name of ["", "Dev:write_items", "Dev,Other", "a/b", " Junto", "Junto ", "Ju\nnto", "x".repeat(129)]) expect(valid(name), JSON.stringify(name)).toBe(false);
  });

  it("matches a reference by the vault's exact name", () => {
    expect(isRefInVault("op://Junto/item/field", "Junto")).toBe(true);
    expect(isRefInVault("op://Junto-other/item/field", "Junto")).toBe(false);
    expect(isRefInVault("op://Personal/item/field", "Junto")).toBe(false);
    expect(vaultOfRef("op://Junto/item/field")).toBe("Junto");
    expect(vaultOfRef("not-a-ref")).toBeUndefined();
  });
});

describe("a region with a vault", () => {
  const decode = Schema.decodeUnknownResult(RegionEnvironment);
  const vault = { backend: "onepassword", vault: "Junto" };

  it("takes vault references, and 1Password sources with their own token anywhere", () => {
    expect(decode({ vault, sources: [
      { id: "a", kind: "onepassword", name: "API_KEY", ref: "op://Junto/api/credential" },
      { id: "b", kind: "onepassword", name: "OTHER", ref: "op://Dev/other/credential", tokenFrom: "t" },
    ] })._tag).toBe("Success");
  });

  it("refuses a vault reference outside its vault, and a vault name that would widen the mint", () => {
    expect(decode({ vault, sources: [{ id: "a", kind: "onepassword", name: "API_KEY", ref: "op://Personal/api/credential" }] })._tag).toBe("Failure");
    expect(decode({ vault: { backend: "onepassword", vault: "Junto:write_items" } })._tag).toBe("Failure");
    expect(decode({ vault: { backend: "keychain", vault: "Junto" } })._tag).toBe("Failure");
  });

  it("without a vault, 1Password references are as before", () => {
    expect(decode({ sources: [{ id: "a", kind: "onepassword", name: "API_KEY", ref: "op://Personal/api/credential" }] })._tag).toBe("Success");
  });
});

describe("this machine's vault token file", () => {
  it("is written whole at 0600 under a 0700 directory, read back, and known to the scrub", async () => {
    const root = await freshHome();
    expect(await readVaultToken(root)).toBeUndefined();
    await writeVaultToken(root, TOKEN);
    expect((await lstat(vaultDir(root))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(vaultDir(root), "op-token"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(vaultDir(root), "op-token"), "utf8")).toBe(`${TOKEN}\n`);
    expect(await readVaultToken(root)).toBe(TOKEN);
    expect(scrubMessage(`op said ${TOKEN.slice(0, 30)}${TOKEN.slice(30)} once`)).not.toContain(TOKEN);
    await removeVaultToken(root);
    expect(await readVaultToken(root)).toBeUndefined();
  });

  it("refuses a value that is not a token without repeating it, a link, and a file others can read", async () => {
    const root = await freshHome();
    const notToken = "hunter2-not-a-service-account-token";
    const refused = await writeVaultToken(root, notToken).then(() => undefined, (cause: unknown) => cause);
    expect(refused).toMatchObject({ _tag: "VaultTokenFileRefused", check: "unreadable" });
    expect(JSON.stringify(refused) + String((refused as Error).message)).not.toContain(notToken);
    await writeVaultToken(root, TOKEN);
    const file = join(vaultDir(root), "op-token");
    await chmod(file, 0o644);
    await expect(readVaultToken(root)).rejects.toMatchObject({ check: "not-owned" });
    await rm(file);
    const elsewhere = join(root, "elsewhere");
    await writeFile(elsewhere, `${TOKEN}\n`, { mode: 0o600 });
    await symlink(elsewhere, file);
    await expect(readVaultToken(root)).rejects.toMatchObject({ check: "not-file" });
  });
});

describe("the scope record", () => {
  it("is one row per machine, names only, replaced by a newer token and removed with it", async () => {
    const root = await freshHome();
    const runtime = ManagedRuntime.make(Layer.provide(VaultTokensLive, makeStateEngineLive(join(root, "junto.db"))));
    try {
      const run = <A, E>(effect: Effect.Effect<A, E, VaultTokens>) => runtime.runPromise(effect);
      const tokens = await run(Effect.service(VaultTokens));
      await run(tokens.put({ machineName: "mini", vault: "Junto", permissions: "read_items", origin: "pasted", setAtEpochMs: 1 }));
      await run(tokens.put({ machineName: "macbook", vault: "Junto", permissions: "read_items,write_items", origin: "minted", accountName: "junto-macbook-write", setAtEpochMs: 2 }));
      await run(tokens.put({ machineName: "mini", vault: "Junto", permissions: "read_items", origin: "minted", accountName: "junto-mini-read", setAtEpochMs: 3 }));
      expect(await run(tokens.list)).toEqual([
        { machineName: "macbook", vault: "Junto", permissions: "read_items,write_items", origin: "minted", accountName: "junto-macbook-write", setAtEpochMs: 2 },
        { machineName: "mini", vault: "Junto", permissions: "read_items", origin: "minted", accountName: "junto-mini-read", setAtEpochMs: 3 },
      ]);
      await expect(run(tokens.put({ machineName: "vps", vault: "Dev:write_items", permissions: "read_items", origin: "pasted", setAtEpochMs: 4 }))).rejects.toBeDefined();
      await run(tokens.remove("mini"));
      expect(await run(tokens.get("mini"))).toBeUndefined();
      expect((await run(tokens.get("macbook")))?.origin).toBe("minted");
    } finally {
      await runtime.dispose();
    }
  });
});

it("the scrub's 1Password token shape covers every character VaultTokenSecret admits", async () => {
  const { scrubText } = await import("../src/main/junto/credentials/scrub");
  const { VaultTokenSecret } = await import("../src/shared/vault");
  const body = "eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSJ9+/=_.-AbC0123456789xyz";
  const token = `ops_${body}`;
  expect(Schema.is(VaultTokenSecret)(token)).toBe(true);
  const scrubbed = scrubText(`op said ${token} then stopped`, []);
  for (const part of ["+/=", "_.-AbC", "eyJzaWdu"]) expect(scrubbed).not.toContain(part);
  expect(scrubbed.startsWith("op said ")).toBe(true);
});
