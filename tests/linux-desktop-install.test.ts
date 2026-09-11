import { createPackage } from "@electron/asar";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINUX_DESKTOP_RELEASE_SCHEMA, LINUX_DESKTOP_TARGET, linuxDesktopArchiveName, type LinuxDesktopReleaseDescriptor } from "../src/shared/linux-desktop-release";
import { signLinuxDesktopRelease, verifyLinuxDesktopRelease, type LinuxDesktopReleaseTrust, type VerifiedLinuxDesktopRelease } from "../src/shared/linux-desktop-release-crypto";
import { installLinuxDesktop } from "../src/main/vellum-command/update/linux-first-install";
import { activateLinuxDesktopRelease, assertLinuxDesktopFirstInstallAvailable, assertLinuxDesktopManagedIncumbent, holdLinuxDesktopInstallReadiness, LinuxDesktopActivationError, linuxDesktopInstallStorageDoctor, markLinuxDesktopInstallReady, revalidateLinuxDesktopRelease, stageLinuxDesktopRelease, type StagedLinuxDesktopRelease } from "../src/main/vellum-command/update/linux-install";

const fault = vi.hoisted(() => ({ syncPath: undefined as string | undefined, syncSuffix: undefined as string | undefined }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (typeof args[0] === "string" && (args[0] === fault.syncPath || (fault.syncSuffix !== undefined && args[0].endsWith(fault.syncSuffix)))) {
      handle.sync = async () => { throw new Error("injected durable write failure"); };
    }
    return handle;
  } };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  fault.syncPath = undefined;
  fault.syncSuffix = undefined;
  holdLinuxDesktopInstallReadiness(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const keyPair = generateKeyPairSync("ed25519");
const fingerprint = sha256(keyPair.publicKey.export({ type: "spki", format: "der" }));
const keyring = {
  schema: "vellum/linux-release-keyring/v1" as const,
  revision: 1,
  keys: [{ keyId: "ephemeral-installer-test", algorithm: "ed25519" as const, publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(), fingerprintSha256: fingerprint, status: "active" as const, validFrom: "2020-01-01T00:00:00.000Z" }],
};
const trust: LinuxDesktopReleaseTrust = { keyring, policy: { schema: "vellum/linux-release-trust-policy/v1", state: "configured", trustedKeyringRevision: 1, trustedKeyringSha256: sha256(`${JSON.stringify(keyring, null, 2)}\n`), trustedKeyId: keyring.keys[0]!.keyId, trustedKeyFingerprintSha256: fingerprint } };
const SOURCE = "a".repeat(40);

interface Member { readonly path: string; readonly type?: Header["type"]; readonly body?: Buffer | string; readonly mode?: number; readonly size?: number; readonly linkpath?: string; }
const archiveBytes = (members: readonly Member[]): Buffer => {
  const chunks: Buffer[] = [];
  for (const entry of members) {
    const body = typeof entry.body === "string" ? Buffer.from(entry.body) : entry.body ?? Buffer.alloc(0);
    const header = new Header({ path: entry.path, type: entry.type ?? "File", mode: entry.mode ?? (entry.type === "Directory" ? 0o755 : 0o644), size: entry.size ?? body.length, uid: 1000, gid: 1000, mtime: new Date(0), ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }) });
    const block = Buffer.alloc(512);
    header.encode(block);
    chunks.push(block, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
};

const makeRoot = async (): Promise<{ readonly root: string; readonly home: string }> => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "vellum-command-linux-install-test-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  return { root, home };
};

const authenticate = (version: string, archive: Buffer): VerifiedLinuxDesktopRelease => {
  const filename = `vellum-command-runtime-${version}-linux-x64.tar.gz`;
  const descriptor: LinuxDesktopReleaseDescriptor = {
    schema: LINUX_DESKTOP_RELEASE_SCHEMA, product: "Vellum Command", channel: "alpha", version, sourceRevision: SOURCE,
    createdAt: "2026-01-01T00:00:00.000Z", target: LINUX_DESKTOP_TARGET,
    archive: { file: filename, path: `/linux/x64/${filename}`, bytes: archive.length, sha256: sha256(archive) },
    sources: { path: `/linux/x64/sources/${version}/sources.json`, bytes: 1, sha256: "b".repeat(64) },
    trust: { algorithm: "ed25519", keyId: keyring.keys[0]!.keyId, keyringRevision: 1 },
  };
  return verifyLinuxDesktopRelease(signLinuxDesktopRelease(descriptor, keyPair.privateKey), { trust, now: "2026-09-10T00:00:00.000Z" });
};

const makeAsar = async (root: string, version: string, change?: "version" | "source" | "payload" | "marker"): Promise<Buffer> => {
  const directory = await mkdtemp(join(root, "asar-input-"));
  await mkdir(join(directory, "out/main"), { recursive: true });
  const buildIdentity = { schema: "vellum-command/runtime-build-identity/v1", cohortNonce: "ba035b20-2435-4af4-83b7-71839c4feec7", sourceCommit: SOURCE, runtime: "electron-main" };
  const marker = change === "marker" ? { ...buildIdentity, cohortNonce: "cc035b20-2435-4af4-83b7-71839c4feec7" } : buildIdentity;
  const main = Buffer.from(`// harmless packaged fixture\n/* VELLUM_COMMAND_RUNTIME_BUILD_IDENTITY:${Buffer.from(JSON.stringify(marker)).toString("base64url")} */\n`);
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@skastr0/vellum-command", version: change === "version" ? "0.0.1" : version }));
  await writeFile(join(directory, "out/main/index.js"), main);
  await writeFile(join(directory, "out/package-runtime-provenance.json"), JSON.stringify({ schema: "vellum-command/package-runtime-provenance/v2", product: "Vellum Command", runtime: "electron-main", appVersion: version, sourceCommit: change === "source" ? "c".repeat(40) : SOURCE, buildIdentity, state: {}, payload: { packagedPath: "out/main/index.js", bytes: main.length, sha256: change === "payload" ? "0".repeat(64) : sha256(main) } }));
  const path = `${directory}.asar`;
  await createPackage(directory, path);
  return readFile(path);
};

const fixture = async (options: { readonly root?: string; readonly home?: string; readonly version?: string; readonly change?: "version" | "source" | "payload" | "marker"; readonly members?: (rootName: string) => readonly Member[] } = {}) => {
  const location = options.root === undefined ? await makeRoot() : { root: options.root, home: options.home! };
  const version = options.version ?? "0.3.0";
  const rootName = `vellum-command-runtime-${version}-linux-x64`;
  const members: readonly Member[] = options.members?.(rootName) ?? [
    { path: `${rootName}/`, type: "Directory" },
    { path: `${rootName}/vellum-command`, mode: 0o755, body: "#!/bin/sh\nexit 0\n" },
    { path: `${rootName}/resources/`, type: "Directory" },
    { path: `${rootName}/resources/app.asar`, body: await makeAsar(location.root, version, options.change) },
  ];
  const bytes = archiveBytes(members);
  const archivePath = join(location.root, `${version}-${sha256(bytes)}.tar.gz`);
  await writeFile(archivePath, bytes);
  return { ...location, archivePath, descriptor: authenticate(version, bytes), bytes };
};
const stage = (input: Awaited<ReturnType<typeof fixture>>) => stageLinuxDesktopRelease(input);
const active = (home: string) => join(home, ".local/bin/vellum-command-desktop");

describe("rootless Linux desktop installation", () => {
  it("unmocked first install rejects an attacker-signed tarball before extraction", async () => {
    const version = "0.3.0";
    const input = await fixture({
      version,
      members: (rootName) => [
        { path: `${rootName}/`, type: "Directory" },
        {
          path: `${rootName}/vellum-command`,
          mode: 0o755,
          body: "#!/bin/sh\nprintf executed > /tmp/vellum-command-candidate-executed\n",
        },
      ],
    });
    const archiveName = linuxDesktopArchiveName(version);
    const archivePath = join(input.root, archiveName);
    await writeFile(archivePath, input.bytes);
    const sources = {
      schema: "vellum-command/release-sources/v1",
      product: "Vellum Command",
      version,
      sourceCommit: SOURCE,
      access: "same-download-location",
      files: [{ file: "synthetic-source.tar.gz", bytes: 1, sha256: "b".repeat(64) }],
      binaries: [{ file: archiveName, bytes: input.bytes.length, sha256: sha256(input.bytes) }],
    };
    const sourcesPath = join(input.root, "sources.json");
    const sourcesBytes = Buffer.from(JSON.stringify(sources));
    await writeFile(sourcesPath, sourcesBytes);
    const descriptor: LinuxDesktopReleaseDescriptor = {
      ...input.descriptor,
      sources: {
        path: `/linux/x64/sources/${version}/sources.json`,
        bytes: sourcesBytes.length,
        sha256: sha256(sourcesBytes),
      },
    };
    const releasePath = join(input.root, "release.json");
    await writeFile(
      releasePath,
      JSON.stringify(signLinuxDesktopRelease(descriptor, keyPair.privateKey)),
    );
    await expect(installLinuxDesktop({
      release: releasePath,
      archive: archivePath,
      sources: sourcesPath,
      home: input.home,
    }, { assertTarget: async () => undefined })).rejects.toThrow(/pinned signing trust/);
    await expect(lstat(join(input.home, ".local"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(active(input.home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires the cryptographic verifier's exact descriptor object", async () => {
    const input = await fixture();
    await expect(stageLinuxDesktopRelease({ ...input, descriptor: { ...input.descriptor } as VerifiedLinuxDesktopRelease })).rejects.toThrow("authenticated release");
    await expect(lstat(join(input.home, ".local"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("authenticates bytes before extracting and rejects source symlinks", async () => {
    const input = await fixture();
    await writeFile(input.archivePath, Buffer.alloc(input.bytes.length));
    await expect(stage(input)).rejects.toThrow("checksum");
    expect((await readdir(join(input.home, ".local/opt/vellum-command-alpha"))).filter((name) => !name.startsWith("."))).toEqual([]);
    const alias = join(input.root, "alias.tar.gz");
    await symlink(input.archivePath, alias);
    await expect(stageLinuxDesktopRelease({ ...input, archivePath: alias })).rejects.toThrow();
  });

  it.each([
    ["traversal", (root: string): Member => ({ path: `${root}/../outside`, body: "escape" })],
    ["absolute", (): Member => ({ path: "/outside", body: "escape" })],
    ["symlink", (root: string): Member => ({ path: `${root}/link`, type: "SymbolicLink", linkpath: "/outside" })],
    ["hardlink", (root: string): Member => ({ path: `${root}/link`, type: "Link", linkpath: `${root}/vellum-command` })],
    ["device", (root: string): Member => ({ path: `${root}/device`, type: "CharacterDevice" })],
    ["setuid", (root: string): Member => ({ path: `${root}/evil`, mode: 0o4755, body: "x" })],
    ["writable", (root: string): Member => ({ path: `${root}/evil`, mode: 0o666, body: "x" })],
    ["missing parent", (root: string): Member => ({ path: `${root}/absent/file`, body: "x" })],
    ["duplicate", (root: string): Member => ({ path: `${root}/vellum-command`, body: "replacement" })],
    ["oversized", (root: string): Member => ({ path: `${root}/large`, size: 1_000_000_001 })],
  ] as const)("rejects authenticated archives with %s entries", async (_label, bad) => {
    const input = await fixture({ members: (root) => [{ path: `${root}/`, type: "Directory" }, { path: `${root}/vellum-command`, mode: 0o755, body: "safe" }, bad(root)] });
    await expect(stage(input)).rejects.toThrow();
    expect((await readdir(join(input.home, ".local/opt/vellum-command-alpha"))).filter((name) => !name.startsWith("."))).toEqual([]);
    await expect(lstat(active(input.home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates an inactive generation, then publishes a launcher without touching product state", async () => {
    const input = await fixture();
    const database = join(input.home, ".vellum-command/state/vellum-command.db");
    await mkdir(dirname(database), { recursive: true });
    await writeFile(database, "installed state sentinel");
    const candidate = await stage(input);
    await expect(lstat(active(input.home))).rejects.toMatchObject({ code: "ENOENT" });
    await revalidateLinuxDesktopRelease(candidate);
    await activateLinuxDesktopRelease(candidate, { mode: "first-install" });
    expect(await readFile(active(input.home), "utf8")).toContain(`exec '${candidate.executablePath}' "$@"`);
    expect((await lstat(active(input.home))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(input.home, ".local/share/applications/vellum-command.desktop"), "utf8")).toContain(`Exec="${active(input.home)}" %U`);
    expect(await readFile(database, "utf8")).toBe("installed state sentinel");
    await expect(activateLinuxDesktopRelease(candidate, { mode: "first-install" })).rejects.toThrow("consumed");
  });

  it("accepts bounded GNU long-name metadata used by the actual Linux packager", async () => {
    const location = await makeRoot();
    const asar = await makeAsar(location.root, "0.3.0");
    const filename = `${"long-".repeat(35)}asset.txt`;
    const input = await fixture({ ...location, members: (root) => [
      { path: `${root}/`, type: "Directory" },
      { path: `${root}/vellum-command`, mode: 0o755, body: "safe executable" },
      { path: `${root}/resources/`, type: "Directory" },
      { path: `${root}/resources/app.asar`, body: asar },
      { path: "././@LongLink", type: "NextFileHasLongPath", body: `${root}/resources/${filename}\0` },
      { path: "placeholder", body: "long filename payload" },
    ] });
    const candidate = await stage(input);
    expect(await readFile(join(candidate.generationPath, "resources", filename), "utf8")).toBe("long filename payload");
  });

  const pad512 = (bytes: Buffer): Buffer => Buffer.concat([bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
  const rawHeader = (path: string, size: number, type: string, mode = 0o644): Buffer => {
    const header = new Header({ path, type: type as Header["type"], mode, size, uid: 1000, gid: 1000, mtime: new Date(0) });
    const block = Buffer.alloc(512);
    header.encode(block);
    return block;
  };
  const paxRecord = (key: string, value: string): Buffer => {
    const kv = ` ${key}=${value}\n`;
    let digits = String(Buffer.byteLength(kv) + 1).length;
    for (;;) {
      const total = Buffer.byteLength(String(digits) + kv) + digits;
      if (String(total).length === digits) return Buffer.from(`${total}${kv}`);
      digits = String(total).length;
    }
  };

  it("rejects PAX metadata that embeds a NUL in the path", async () => {
    const location = await makeRoot();
    const version = "0.3.0";
    const rootName = `vellum-command-runtime-${version}-linux-x64`;
    const pax = paxRecord("path", `${rootName}/visible.txt\0hidden.txt`);
    const body = Buffer.from("payload");
    const archive = gzipSync(Buffer.concat([
      rawHeader("PaxHeader/poc", pax.length, "ExtendedHeader"),
      pad512(pax),
      rawHeader(`${rootName}/visible.txt`, body.length, "File"),
      pad512(body),
      Buffer.alloc(1024),
    ]));
    const archivePath = join(location.root, `${version}-${sha256(archive)}.tar.gz`);
    await writeFile(archivePath, archive);
    await expect(stageLinuxDesktopRelease({ archivePath, descriptor: authenticate(version, archive), home: location.home })).rejects.toThrow(/NUL|unsafe|unsupported/u);
    expect((await readdir(join(location.home, ".local/opt/vellum-command-alpha")).catch(() => [])).filter((name) => !name.startsWith("."))).toEqual([]);
  });

  it("rejects a numeric PAX path that would crash unpack", async () => {
    const location = await makeRoot();
    const version = "0.3.0";
    const rootName = `vellum-command-runtime-${version}-linux-x64`;
    const pax = paxRecord("path", "12345");
    const archive = gzipSync(Buffer.concat([
      rawHeader("PaxHeader/poc", pax.length, "ExtendedHeader"),
      pad512(pax),
      rawHeader(`${rootName}/placeholder`, 0, "Directory", 0o755),
      Buffer.alloc(1024),
    ]));
    const archivePath = join(location.root, `${version}-${sha256(archive)}.tar.gz`);
    await writeFile(archivePath, archive);
    await expect(stageLinuxDesktopRelease({ archivePath, descriptor: authenticate(version, archive), home: location.home })).rejects.toThrow();
    await expect(lstat(active(location.home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects oversized PAX metadata instead of falling back to the ordinary header name", async () => {
    const location = await makeRoot();
    const version = "0.3.0";
    const rootName = `vellum-command-runtime-${version}-linux-x64`;
    const pax = paxRecord("path", `${rootName}/${"a".repeat(5000)}`);
    const archive = gzipSync(Buffer.concat([
      rawHeader("PaxHeader/poc", pax.length, "ExtendedHeader"),
      pad512(pax),
      rawHeader(`${rootName}/placeholder`, 0, "File"),
      Buffer.alloc(1024),
    ]));
    const archivePath = join(location.root, `${version}-${sha256(archive)}.tar.gz`);
    await writeFile(archivePath, archive);
    await expect(stageLinuxDesktopRelease({ archivePath, descriptor: authenticate(version, archive), home: location.home })).rejects.toThrow(/unsupported|meta|unsafe/u);
  });

  it("rejects a truncated gzip after authentication", async () => {
    const input = await fixture();
    const truncated = input.bytes.subarray(0, Math.max(16, Math.floor(input.bytes.length / 2)));
    await writeFile(input.archivePath, truncated);
    const descriptor = authenticate("0.3.0", truncated);
    await expect(stageLinuxDesktopRelease({ archivePath: input.archivePath, descriptor, home: input.home })).rejects.toThrow();
    expect((await readdir(join(input.home, ".local/opt/vellum-command-alpha")).catch(() => [])).filter((name) => !name.startsWith("."))).toEqual([]);
  });

  it("first install refuses an existing managed launcher, while update preserves the previous generation", async () => {
    const initial = await fixture();
    const old = await stage(initial);
    await activateLinuxDesktopRelease(old, { mode: "first-install" });
    const before = await readFile(active(initial.home), "utf8");
    const input = await fixture({ ...initial, version: "0.3.1" });
    const candidate = await stage(input);
    await expect(activateLinuxDesktopRelease(candidate, { mode: "first-install" })).rejects.toMatchObject({ activated: false });
    await expect(activateLinuxDesktopRelease(candidate, { mode: "update", expectedIncumbentExecutablePath: "/unmanaged/vellum-command" })).rejects.toThrow("exact managed");
    expect(await readFile(active(initial.home), "utf8")).toBe(before);
    await activateLinuxDesktopRelease(candidate, { mode: "update", expectedIncumbentExecutablePath: old.executablePath });
    expect(await readFile(active(initial.home), "utf8")).toContain(candidate.executablePath);
    expect(await readFile(old.executablePath, "utf8")).toContain("exit 0");
  });

  it("refuses forged staged handles and unmanaged update attempts", async () => {
    const input = await fixture();
    const candidate = await stage(input);
    await expect(revalidateLinuxDesktopRelease({ ...candidate } as StagedLinuxDesktopRelease)).rejects.toThrow("not staged");
    await expect(activateLinuxDesktopRelease(candidate, { mode: "update", expectedIncumbentExecutablePath: candidate.executablePath })).rejects.toThrow("exact managed");
  });

  it("checks managed-install eligibility without creating files", async () => {
    const input = await fixture();
    await expect(assertLinuxDesktopManagedIncumbent({ home: input.home, executablePath: "/unmanaged/vellum-command" })).rejects.toThrow();
    await expect(lstat(join(input.home, ".local"))).rejects.toMatchObject({ code: "ENOENT" });
    const candidate = await stage(input);
    await activateLinuxDesktopRelease(candidate, { mode: "first-install" });
    await expect(assertLinuxDesktopManagedIncumbent({ home: input.home, executablePath: candidate.executablePath })).resolves.toBeUndefined();
    await expect(assertLinuxDesktopManagedIncumbent({ home: input.home, executablePath: "/unmanaged/vellum-command" })).rejects.toThrow("exact managed");
  });

  it("first-install eligibility is read-only and refuses foreign entries", async () => {
    const input = await fixture();
    await expect(assertLinuxDesktopFirstInstallAvailable({ home: input.home })).resolves.toBeUndefined();
    await expect(lstat(join(input.home, ".local"))).rejects.toMatchObject({ code: "ENOENT" });
    const desktop = join(input.home, ".local/share/applications/vellum-command.desktop");
    await mkdir(dirname(desktop), { recursive: true, mode: 0o700 });
    await writeFile(desktop, "existing desktop entry");
    await expect(assertLinuxDesktopFirstInstallAvailable({ home: input.home })).rejects.toThrow("unrelated");
    expect(await readFile(desktop, "utf8")).toBe("existing desktop entry");
  });

  it("recovers launcher hardlinks from interrupted create-only publication without touching unknown links", async () => {
    const initial = await fixture();
    const old = await stage(initial);
    await activateLinuxDesktopRelease(old, { mode: "first-install" });
    const alias = join(initial.root, "retained-launcher-link");
    await link(active(initial.home), alias);
    const oldBody = await readFile(alias, "utf8");
    await assertLinuxDesktopManagedIncumbent({ home: initial.home, executablePath: old.executablePath });
    const candidate = await stage(await fixture({ ...initial, version: "0.3.1" }));
    await activateLinuxDesktopRelease(candidate, { mode: "update", expectedIncumbentExecutablePath: old.executablePath });
    expect(await readFile(active(initial.home), "utf8")).toContain(candidate.executablePath);
    expect(await readFile(alias, "utf8")).toBe(oldBody);
  });

  it("still rejects hardlinked archive and payload files", async () => {
    const input = await fixture();
    const alias = join(input.root, "archive-alias");
    await link(input.archivePath, alias);
    await expect(stage(input)).rejects.toThrow("regular file");
    await rm(alias);
    const candidate = await stage(input);
    await link(candidate.executablePath, join(input.root, "payload-alias"));
    await expect(revalidateLinuxDesktopRelease(candidate)).rejects.toThrow("unsafe file");
  });

  it("rejects elevated staging before creating install directories", async () => {
    const input = await fixture();
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    await expect(stage(input)).rejects.toThrow("ordinary user");
    await expect(lstat(join(input.home, ".local"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses same-version or older update activation", async () => {
    const input = await fixture();
    const initial = await stage(input);
    await activateLinuxDesktopRelease(initial, { mode: "first-install" });
    const duplicate = await stage(input);
    await expect(activateLinuxDesktopRelease(duplicate, { mode: "update", expectedIncumbentExecutablePath: initial.executablePath })).rejects.toThrow("strictly newer");
    const older = await stage(await fixture({ ...input, version: "0.2.9" }));
    await expect(activateLinuxDesktopRelease(older, { mode: "update", expectedIncumbentExecutablePath: initial.executablePath })).rejects.toThrow("strictly newer");
  });

  it.each(["content", "mode", "extra", "link"] as const)("rejects %s tampering before activation", async (kind) => {
    const input = await fixture();
    const candidate = await stage(input);
    if (kind === "content") await writeFile(candidate.executablePath, "modified content");
    if (kind === "mode") await chmod(candidate.executablePath, 0o644);
    if (kind === "extra") await writeFile(join(candidate.generationPath, "extra"), "unexpected");
    if (kind === "link") {
      await rm(candidate.executablePath);
      await symlink(input.archivePath, candidate.executablePath);
    }
    await expect(activateLinuxDesktopRelease(candidate, { mode: "first-install" })).rejects.toMatchObject({ activated: false });
    await expect(lstat(active(input.home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects replacement of the generation even when its bytes are identical", async () => {
    const input = await fixture();
    const candidate = await stage(input);
    await rename(candidate.generationPath, `${candidate.generationPath}-retained`);
    await cp(`${candidate.generationPath}-retained`, candidate.generationPath, { recursive: true, preserveTimestamps: true });
    await expect(revalidateLinuxDesktopRelease(candidate)).rejects.toThrow("filesystem identity");
  });

  it.each(["version", "source", "payload", "marker"] as const)("binds packaged %s identity to the signed release", async (change) => {
    const input = await fixture({ change });
    await expect(stage(input)).rejects.toThrow(/Packaged update/u);
    await expect(lstat(active(input.home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses unrelated launcher and desktop-entry conflicts", async () => {
    const input = await fixture();
    await mkdir(dirname(active(input.home)), { recursive: true, mode: 0o700 });
    await writeFile(active(input.home), "unrelated command", { mode: 0o755 });
    await expect(stage(input)).rejects.toThrow("unrelated");
    expect(await readFile(active(input.home), "utf8")).toBe("unrelated command");
    await rm(active(input.home));
    const desktop = join(input.home, ".local/share/applications/vellum-command.desktop");
    await mkdir(dirname(desktop), { recursive: true, mode: 0o700 });
    await writeFile(desktop, "unrelated desktop entry");
    await expect(stage(input)).rejects.toThrow("unrelated desktop");
    expect(await readFile(desktop, "utf8")).toBe("unrelated desktop entry");
  });

  it("refuses symlinked installation parents without modifying their target", async () => {
    const input = await fixture();
    const outside = join(input.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(input.home, ".local"));
    await expect(stage(input)).rejects.toThrow("owner-controlled");
    expect(await readdir(outside)).toEqual([]);
  });

  it("fails before activation when admitted payload cannot be made durable", async () => {
    const input = await fixture();
    fault.syncSuffix = "/vellum-command";
    await expect(stage(input)).rejects.toThrow("durable write failure");
    await expect(lstat(active(input.home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("can re-admit an inactive generation after its parent-directory sync failed", async () => {
    const input = await fixture();
    fault.syncPath = join(input.home, ".local/opt/vellum-command-alpha");
    await expect(stage(input)).rejects.toThrow("durable write failure");
    await expect(lstat(active(input.home))).rejects.toMatchObject({ code: "ENOENT" });
    fault.syncPath = undefined;
    const candidate = await stage(input);
    await revalidateLinuxDesktopRelease(candidate);
    await activateLinuxDesktopRelease(candidate, { mode: "first-install" });
    expect(await readFile(active(input.home), "utf8")).toContain(candidate.executablePath);
  });

  it("reports the irreversible boundary when launcher-directory sync fails", async () => {
    const input = await fixture();
    const candidate = await stage(input);
    fault.syncPath = dirname(active(input.home));
    let failure: unknown;
    try { await activateLinuxDesktopRelease(candidate, { mode: "first-install" }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(LinuxDesktopActivationError);
    expect(failure).toMatchObject({ activated: true });
    expect(await readFile(active(input.home), "utf8")).toContain(candidate.executablePath);
    expect(await readFile(candidate.executablePath, "utf8")).toContain("exit 0");
  });

  it("resumes a first install interrupted after desktop publication, including a retained temporary hardlink", async () => {
    const input = await fixture();
    const candidate = await stage(input);
    const desktop = join(input.home, ".local/share/applications/vellum-command.desktop");
    fault.syncPath = dirname(desktop);
    await expect(activateLinuxDesktopRelease(candidate, { mode: "first-install" })).rejects.toMatchObject({ activated: false });
    await expect(lstat(active(input.home))).rejects.toMatchObject({ code: "ENOENT" });
    fault.syncPath = undefined;
    const alias = join(input.root, "interrupted-desktop-link");
    await link(desktop, alias);
    const before = await lstat(desktop);
    await assertLinuxDesktopFirstInstallAvailable({ home: input.home });
    const retry = await stage(input);
    await activateLinuxDesktopRelease(retry, { mode: "first-install" });
    expect((await lstat(desktop)).ino).toBe(before.ino);
    expect(await readFile(alias, "utf8")).toBe(await readFile(desktop, "utf8"));
    expect(await readFile(active(input.home), "utf8")).toContain(retry.executablePath);
  });

  it("leaves the incumbent selected when desktop-entry durability fails before the switch", async () => {
    const initial = await fixture();
    const old = await stage(initial);
    await activateLinuxDesktopRelease(old, { mode: "first-install" });
    const before = await readFile(active(initial.home), "utf8");
    const next = await fixture({ ...initial, version: "0.3.1" });
    const candidate = await stage(next);
    fault.syncPath = join(initial.home, ".local/share/applications");
    await expect(activateLinuxDesktopRelease(candidate, { mode: "update", expectedIncumbentExecutablePath: old.executablePath })).rejects.toMatchObject({ activated: false });
    expect(await readFile(active(initial.home), "utf8")).toBe(before);
  });

  it("keeps the previous generation through activation and retires it after successor readiness", async () => {
    const initial = await fixture();
    const old = await stage(initial);
    await activateLinuxDesktopRelease(old, { mode: "first-install" });
    const next = await fixture({ ...initial, version: "0.3.1" });
    const candidate = await stage(next);
    await activateLinuxDesktopRelease(candidate, { mode: "update", expectedIncumbentExecutablePath: old.executablePath });
    expect(await readFile(old.executablePath, "utf8")).toContain("exit 0");
    await markLinuxDesktopInstallReady({ home: initial.home, executablePath: candidate.executablePath });
    await expect(lstat(old.executablePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(candidate.executablePath, "utf8")).toContain("exit 0");
    expect(await readFile(active(initial.home), "utf8")).toContain(candidate.executablePath);
  });

  it("does not delete an unproven leftover generation and reports it in Doctor", async () => {
    const initial = await fixture();
    const installed = await stage(initial);
    await activateLinuxDesktopRelease(installed, { mode: "first-install" });
    const leftover = join(initial.home, ".local/opt/vellum-command-alpha", `0.1.0-${"c".repeat(64)}`);
    await mkdir(leftover, { mode: 0o700 });
    await writeFile(join(leftover, "vellum-command"), "foreign leftover\n", { mode: 0o755 });
    await markLinuxDesktopInstallReady({ home: initial.home, executablePath: installed.executablePath });
    expect(await readFile(join(leftover, "vellum-command"), "utf8")).toBe("foreign leftover\n");
    const check = await linuxDesktopInstallStorageDoctor({ home: initial.home, executablePath: installed.executablePath });
    expect(check?.id).toBe("linux-install-storage");
    expect(check?.metadata?.legacyGenerationCount).toBe("1");
    expect(check?.status).toBe("warning");
  });
});
