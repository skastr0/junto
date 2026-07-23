import {
  generateKeyPairSync,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { createSshProgramCompiler } from "../src/main/vellum/ssh/program";
import type { SshTransport } from "../src/main/vellum/ssh/service";
import {
  installStationBrowserTrustFrame,
  makeStationBrowserTrustStore,
  pinnedTrustForOriginKey,
  provisionStationBrowserTrust,
  revokePinnedTrust,
  STATION_BROWSER_TRUST_DIRECTORY_MODE,
  STATION_BROWSER_TRUST_FILE_MODE,
  STATION_BROWSER_TRUST_WRAPPER,
  STATION_BROWSER_TRUST_WRAPPER_ARGS,
} from "../src/main/vellum/browser/station-trust";
import { canonicalStationBrowserJson } from "../src/shared/station-browser";

const roots: string[] = [];
const newHome = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-station-trust-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("station browser delegation key custody", () => {
  it("creates and reloads one owner-private Ed25519 origin identity", async () => {
    const home = await newHome();
    const store = makeStationBrowserTrustStore(home);
    const first = await store.loadOrCreateOriginKey("command-a", 1_700_000_000_000);
    const second = await store.loadOrCreateOriginKey("command-a", 1_800_000_000_000);

    expect(second.keyId).toBe(first.keyId);
    expect(second.generation).toBe(1);
    expect(second.privateKey.asymmetricKeyType).toBe("ed25519");
    expect(second.publicKey.asymmetricKeyType).toBe("ed25519");
    const root = join(home, ".vellum", "station-browser");
    expect((await lstat(root)).mode & 0o777).toBe(STATION_BROWSER_TRUST_DIRECTORY_MODE);
    expect((await lstat(join(root, "origin-key.json"))).mode & 0o777)
      .toBe(STATION_BROWSER_TRUST_FILE_MODE);
    expect(await readFile(join(root, "origin-key.json"), "utf8"))
      .not.toContain("BEGIN PRIVATE KEY");
  });

  it("rotates monotonically and refuses stale custody handles", async () => {
    const home = await newHome();
    const store = makeStationBrowserTrustStore(home);
    const first = await store.loadOrCreateOriginKey("command-a", 1);
    const second = await store.rotateOriginKey(first, 2);
    expect(second.generation).toBe(2);
    expect(second.keyId).not.toBe(first.keyId);
    await expect(store.rotateOriginKey(first, 3))
      .rejects.toThrow("changed before rotation");
  });

  it("fails closed on insecure files, symlinked trust roots, and non-Ed25519 material", async () => {
    const insecure = await newHome();
    const store = makeStationBrowserTrustStore(insecure);
    await store.loadOrCreateOriginKey("command-a", 1);
    const keyPath = join(insecure, ".vellum", "station-browser", "origin-key.json");
    await chmod(keyPath, 0o644);
    await expect(store.loadOrCreateOriginKey("command-a", 2))
      .rejects.toThrow("owner-private");

    const linked = await newHome();
    const outside = await newHome();
    await mkdir(join(linked, ".vellum"), { mode: 0o700 });
    await symlink(outside, join(linked, ".vellum", "station-browser"));
    await expect(
      makeStationBrowserTrustStore(linked).loadOrCreateOriginKey("command-a", 1),
    ).rejects.toThrow("real directory");

    const wrong = await newHome();
    const wrongRoot = join(wrong, ".vellum", "station-browser");
    await mkdir(wrongRoot, { recursive: true, mode: 0o700 });
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPkcs8 = (rsa.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64");
    const publicKeySpki = (rsa.publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
    await writeFile(join(wrongRoot, "origin-key.json"), `${JSON.stringify({
      version: 1,
      generation: 1,
      keyId: "rsa-key",
      originStationId: "command-a",
      createdAt: 1,
      privateKeyPkcs8,
      publicKeySpki,
    })}\n`, { mode: 0o600 });
    await expect(
      makeStationBrowserTrustStore(wrong).loadOrCreateOriginKey("command-a", 2),
    ).rejects.toThrow(/key material|Ed25519|inconsistent/);
  });
});

describe("station browser Remote pinned trust", () => {
  it("installs, rotates, and revokes with irreversible generations", async () => {
    const originHome = await newHome();
    const remoteHome = await newHome();
    const origin = makeStationBrowserTrustStore(originHome);
    const remote = makeStationBrowserTrustStore(remoteHome);
    const first = await origin.loadOrCreateOriginKey("command-a", 1);
    const firstRecord = pinnedTrustForOriginKey(first, null, 1);
    await remote.installPinnedRecord(firstRecord);
    expect(await remote.loadPinnedTrust()).toMatchObject({
      keyId: first.keyId,
      originStationId: "command-a",
    });

    const second = await origin.rotateOriginKey(first, 2);
    const secondRecord = pinnedTrustForOriginKey(second, first.keyId, 2);
    await remote.installPinnedRecord(secondRecord);
    expect((await remote.loadPinnedTrust())?.keyId).toBe(second.keyId);
    await expect(remote.installPinnedRecord(firstRecord))
      .rejects.toThrow("stale or discontinuous");

    const revoked = revokePinnedTrust(secondRecord, 3);
    await remote.installPinnedRecord(revoked);
    expect(await remote.loadPinnedTrust()).toBeUndefined();
    await expect(remote.installPinnedRecord(secondRecord))
      .rejects.toThrow("stale or discontinuous");
  });

  it("target wrapper applies only a bounded canonical record to its fixed store", async () => {
    const originHome = await newHome();
    const remoteHome = await newHome();
    const origin = makeStationBrowserTrustStore(originHome);
    const key = await origin.loadOrCreateOriginKey("command-a", 1);
    const record = pinnedTrustForOriginKey(key, null, 1);
    const response = await installStationBrowserTrustFrame(
      canonicalStationBrowserJson(record),
      makeStationBrowserTrustStore(remoteHome),
    );
    expect(JSON.parse(response)).toEqual({
      version: 1,
      ok: true,
      keyId: key.keyId,
      generation: 1,
      status: "active",
    });
    await expect(
      installStationBrowserTrustFrame(
        `${canonicalStationBrowserJson(record)}\n{"extra":true}`,
        makeStationBrowserTrustStore(remoteHome),
      ),
    ).rejects.toThrow();
  });
});

describe("station browser trust provisioning transport", () => {
  const host = {
    id: "remote-a",
    label: "Remote A",
    kind: "remote" as const,
    endpoint: "remote-a",
    capabilities: ["browser"] as const,
  };

  it("uses one fixed wrapper and bounded stdin without key material in argv", async () => {
    const home = await newHome();
    const store = makeStationBrowserTrustStore(home);
    const key = await store.loadOrCreateOriginKey("command-a", 1);
    const record = pinnedTrustForOriginKey(key, null, 1);
    const programs: unknown[] = [];
    const ssh = {
      run: (program: unknown) => {
        programs.push(program);
        return Effect.succeed({
          stdout: JSON.stringify({
            version: 1,
            ok: true,
            keyId: key.keyId,
            generation: 1,
            status: "active",
          }),
          stderr: "",
        });
      },
    } as unknown as typeof SshTransport.Service;

    await expect(Effect.runPromise(
      provisionStationBrowserTrust(ssh, [host], "remote-a", record),
    )).resolves.toMatchObject({ ok: true, keyId: key.keyId });
    const compiled = createSshProgramCompiler({
      controlDir: "/tmp/vellum-ssh",
      envExecutable: "/usr/bin/env",
      sshExecutable: "/usr/bin/ssh",
      environment: {},
    }).oneShot(programs[0] as never);
    const command = String(compiled.command);
    expect(STATION_BROWSER_TRUST_WRAPPER).toBe("vellum-browser");
    expect(STATION_BROWSER_TRUST_WRAPPER_ARGS).toEqual(["station-trust"]);
    expect(command).toContain("BatchMode=yes");
    expect(command).toContain("ClearAllForwardings=yes");
    expect(command).toContain("vellum-browser");
    expect(command).not.toContain(key.keyId);
    expect(command).not.toContain(record.publicKeySpki);
    expect(new TextDecoder().decode(compiled.input)).toContain(key.keyId);
  });

  it("rejects unknown, injection-shaped, incapable, and malformed acknowledgements", async () => {
    const home = await newHome();
    const store = makeStationBrowserTrustStore(home);
    const key = await store.loadOrCreateOriginKey("command-a", 1);
    const record = pinnedTrustForOriginKey(key, null, 1);
    let calls = 0;
    const ssh = {
      run: () => {
        calls += 1;
        return Effect.succeed({ stdout: "not-json", stderr: "" });
      },
    } as unknown as typeof SshTransport.Service;

    for (const target of ["", "-oProxyCommand=x", "remote-a;id", "$(id)", "remote-a\nid"]) {
      await expect(Effect.runPromise(
        provisionStationBrowserTrust(ssh, [host], target, record),
      )).rejects.toThrow("not a configured Remote");
    }
    await expect(Effect.runPromise(
      provisionStationBrowserTrust(
        ssh,
        [{ ...host, capabilities: ["hermes"] }],
        "remote-a",
        record,
      ),
    )).rejects.toThrow("does not advertise browser capability");
    expect(calls).toBe(0);

    await expect(Effect.runPromise(
      provisionStationBrowserTrust(ssh, [host], "remote-a", record),
    )).rejects.toThrow("invalid response");
    expect(calls).toBe(1);
  });
});
