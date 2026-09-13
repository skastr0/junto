import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINUX_DESKTOP_INSTALL_RESERVE_BYTES,
  LINUX_DESKTOP_MAX_ARCHIVE_BYTES,
  LINUX_DESKTOP_MAX_EXPANDED_BYTES,
  LINUX_DESKTOP_RELEASE_SCHEMA,
  LINUX_DESKTOP_TARGET,
  type LinuxDesktopReleaseDescriptor,
} from "../src/shared/linux-desktop-release";
import { signLinuxDesktopRelease, verifyLinuxDesktopRelease, type LinuxDesktopReleaseTrust } from "../src/shared/linux-desktop-release-crypto";
import {
  activateLinuxDesktopRelease,
  holdLinuxDesktopInstallReadiness,
  markLinuxDesktopInstallReady,
  stageLinuxDesktopRelease,
} from "../src/main/vellum-command/update/linux-install";
import {
  assertLinuxInstallDiskAdmission,
  requiredLinuxInstallStageBytes,
  retireLinuxInstallTree,
  type OwnedLinuxInstallRoot,
  type RetirableLinuxInstallTree,
} from "../src/main/vellum-command/update/linux-install-storage";
import { itOnLinux } from "./helpers/platform";

const roots: string[] = [];
afterEach(async () => {
  holdLinuxDesktopInstallReadiness(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const keyPair = generateKeyPairSync("ed25519");
const fingerprint = sha256(keyPair.publicKey.export({ type: "spki", format: "der" }));
const keyring = {
  schema: "vellum/linux-release-keyring/v1" as const,
  revision: 1,
  keys: [{ keyId: "ephemeral-storage-test", algorithm: "ed25519" as const, publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(), fingerprintSha256: fingerprint, status: "active" as const, validFrom: "2020-01-01T00:00:00.000Z" }],
};
const trust: LinuxDesktopReleaseTrust = { keyring, policy: { schema: "vellum/linux-release-trust-policy/v1", state: "configured", trustedKeyringRevision: 1, trustedKeyringSha256: sha256(`${JSON.stringify(keyring, null, 2)}\n`), trustedKeyId: keyring.keys[0]!.keyId, trustedKeyFingerprintSha256: fingerprint } };
const SOURCE = "a".repeat(40);

const archiveBytes = (members: readonly { path: string; type?: Header["type"]; body?: Buffer | string; mode?: number }[]): Buffer => {
  const chunks: Buffer[] = [];
  for (const entry of members) {
    const body = typeof entry.body === "string" ? Buffer.from(entry.body) : entry.body ?? Buffer.alloc(0);
    const header = new Header({ path: entry.path, type: entry.type ?? "File", mode: entry.mode ?? (entry.type === "Directory" ? 0o755 : 0o644), size: body.length, uid: 1000, gid: 1000, mtime: new Date(0) });
    const block = Buffer.alloc(512);
    header.encode(block);
    chunks.push(block, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
};

const makeAsar = async (root: string, version: string): Promise<Buffer> => {
  const directory = await mkdtemp(join(root, "asar-input-"));
  await mkdir(join(directory, "out/main"), { recursive: true });
  const buildIdentity = { schema: "vellum-command/runtime-build-identity/v1", cohortNonce: "ba035b20-2435-4af4-83b7-71839c4feec7", sourceCommit: SOURCE, runtime: "electron-main" };
  const main = Buffer.from(`// harmless packaged fixture\n/* VELLUM_COMMAND_RUNTIME_BUILD_IDENTITY:${Buffer.from(JSON.stringify(buildIdentity)).toString("base64url")} */\n`);
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@skastr0/vellum-command", version }));
  await writeFile(join(directory, "out/main/index.js"), main);
  await writeFile(join(directory, "out/package-runtime-provenance.json"), JSON.stringify({ schema: "vellum-command/package-runtime-provenance/v2", product: "Vellum Command", runtime: "electron-main", appVersion: version, sourceCommit: SOURCE, buildIdentity, state: {}, payload: { packagedPath: "out/main/index.js", bytes: main.length, sha256: sha256(main) } }));
  const path = `${directory}.asar`;
  await createPackage(directory, path);
  return readFile(path);
};

const fixture = async (options: { home?: string; root?: string; version?: string } = {}) => {
  const root = options.root ?? await mkdtemp(join(await realpath(tmpdir()), "vellum-command-linux-storage-test-"));
  if (options.root === undefined) roots.push(root);
  const home = options.home ?? join(root, "home");
  if (options.home === undefined) await mkdir(home, { mode: 0o700 });
  const version = options.version ?? "0.3.0";
  const rootName = `vellum-command-runtime-${version}-linux-x64`;
  const asar = await makeAsar(root, version);
  const bytes = archiveBytes([
    { path: `${rootName}/`, type: "Directory" },
    { path: `${rootName}/vellum-command`, mode: 0o755, body: "#!/bin/sh\nexit 0\n" },
    { path: `${rootName}/resources/`, type: "Directory" },
    { path: `${rootName}/resources/app.asar`, body: asar },
  ]);
  const archivePath = join(root, `${version}-${sha256(bytes)}.tar.gz`);
  await writeFile(archivePath, bytes);
  const filename = `vellum-command-runtime-${version}-linux-x64.tar.gz`;
  const descriptor: LinuxDesktopReleaseDescriptor = {
    schema: LINUX_DESKTOP_RELEASE_SCHEMA, product: "Vellum Command", channel: "alpha", version, sourceRevision: SOURCE,
    createdAt: "2026-01-01T00:00:00.000Z", target: LINUX_DESKTOP_TARGET,
    archive: { file: filename, path: `/linux/x64/${filename}`, bytes: bytes.length, sha256: sha256(bytes) },
    sources: { path: `/linux/x64/sources/${version}/sources.json`, bytes: 1, sha256: "b".repeat(64) },
    trust: { algorithm: "ed25519", keyId: keyring.keys[0]!.keyId, keyringRevision: 1 },
  };
  return { root, home, archivePath, descriptor: verifyLinuxDesktopRelease(signLinuxDesktopRelease(descriptor, keyPair.privateKey), { trust, now: "2026-09-10T00:00:00.000Z" }) };
};

describe("Linux install storage policy", () => {
  it("computes the conservative staging admission from shared caps", () => {
    expect(requiredLinuxInstallStageBytes(0)).toBe(
      LINUX_DESKTOP_MAX_EXPANDED_BYTES + LINUX_DESKTOP_INSTALL_RESERVE_BYTES,
    );
    expect(requiredLinuxInstallStageBytes(LINUX_DESKTOP_MAX_ARCHIVE_BYTES)).toBe(
      LINUX_DESKTOP_MAX_EXPANDED_BYTES + LINUX_DESKTOP_MAX_ARCHIVE_BYTES + LINUX_DESKTOP_INSTALL_RESERVE_BYTES,
    );
    expect(() => requiredLinuxInstallStageBytes(LINUX_DESKTOP_MAX_ARCHIVE_BYTES + 1)).toThrow(/bound/);
  });

  it("refuses staging admission when free space is below the expansion reserve", async () => {
    await expect(assertLinuxInstallDiskAdmission({
      path: "/tmp",
      archiveBytes: 1,
      observe: async () => ({ bavail: 1n, bsize: 4096n }),
    })).rejects.toThrow(/free disk space/);
  });

  itOnLinux("keeps a live staged candidate while collecting only after readiness", async () => {
    const initial = await fixture();
    const old = await stageLinuxDesktopRelease(initial);
    await activateLinuxDesktopRelease(old, { mode: "first-install" });
    const next = await fixture({ ...initial, version: "0.3.1" });
    const candidate = await stageLinuxDesktopRelease(next);
    await markLinuxDesktopInstallReady({ home: initial.home, executablePath: old.executablePath });
    expect(await readFile(candidate.executablePath, "utf8")).toContain("exit 0");
    expect(await readFile(old.executablePath, "utf8")).toContain("exit 0");
  });

  itOnLinux("rejects a forged retirement handle without touching the tree", async () => {
    const input = await fixture();
    const staged = await stageLinuxDesktopRelease(input);
    await activateLinuxDesktopRelease(staged, { mode: "first-install" });
    await expect(retireLinuxInstallTree({
      root: { home: input.home } as OwnedLinuxInstallRoot,
      lease: { } as never,
      tree: { path: staged.generationPath, basename: "forged" } as RetirableLinuxInstallTree,
    })).rejects.toThrow();
    expect(await readFile(staged.executablePath, "utf8")).toContain("exit 0");
  });
});
