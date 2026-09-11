import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINUX_DESKTOP_RELEASE_SCHEMA,
  LINUX_DESKTOP_TARGET,
  linuxDesktopArchiveName,
  type LinuxDesktopReleaseDescriptor,
} from "../src/shared/linux-desktop-release";
import { signLinuxDesktopRelease } from "../src/shared/linux-desktop-release-crypto";
import {
  installLinuxDesktop,
  linuxDesktopBootstrapIdentity,
  parseLinuxDesktopBootstrapArgs,
  runLinuxDesktopBootstrap,
} from "../src/main/vellum-command/update/linux-first-install";

const seam = vi.hoisted(() => ({
  verify: vi.fn(),
  stage: vi.fn(),
  revalidate: vi.fn(),
  activate: vi.fn(),
  target: vi.fn(),
  firstInstall: vi.fn(),
}));
vi.mock("../src/main/vellum-command/update/linux-target", async () => {
  const actual = await vi.importActual<typeof import("../src/main/vellum-command/update/linux-target")>(
    "../src/main/vellum-command/update/linux-target",
  );
  return { ...actual, assertCurrentLinuxDesktopTarget: seam.target };
});
vi.mock("../src/shared/linux-desktop-release-files", async () => {
  const actual = await vi.importActual<typeof import("../src/shared/linux-desktop-release-files")>(
    "../src/shared/linux-desktop-release-files",
  );
  return { ...actual, verifyLinuxDesktopReleaseFiles: seam.verify };
});
vi.mock("../src/main/vellum-command/update/linux-install", async () => {
  const actual = await vi.importActual<typeof import("../src/main/vellum-command/update/linux-install")>(
    "../src/main/vellum-command/update/linux-install",
  );
  return {
    ...actual,
    stageLinuxDesktopRelease: seam.stage,
    revalidateLinuxDesktopRelease: seam.revalidate,
    activateLinuxDesktopRelease: seam.activate,
    assertLinuxDesktopFirstInstallAvailable: seam.firstInstall,
  };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const capture = (stream: NodeJS.WriteStream) => {
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, "write").mockImplementation((chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return { spy, text: () => chunks.join("") };
};

describe("packaged CLI first-install removal", () => {
  it("does not register desktop-install on the application CLI", async () => {
    const main = await readFile(new URL("../src/cli/main.ts", import.meta.url), "utf8");
    const discovery = await readFile(new URL("../src/cli/core/discovery.ts", import.meta.url), "utf8");
    expect(main).not.toContain("desktop-install");
    expect(main).not.toContain("desktopInstall");
    expect(discovery).not.toContain("desktop-install");
  });
});

describe("Linux desktop first-install CLI", () => {
  it("uses authenticated inputs and the shared create-only transaction without launching", async () => {
    const descriptor = { version: "0.2.1" };
    const staged = {
      executablePath: "/home/example/.local/opt/vellum-command-alpha/0.2.1-hash/vellum-command",
      archiveSha256: "a".repeat(64),
    };
    seam.verify.mockResolvedValue(descriptor);
    seam.stage.mockResolvedValue(staged);
    seam.revalidate.mockResolvedValue(undefined);
    seam.activate.mockResolvedValue(undefined);
    const result = await installLinuxDesktop({
      release: "release.json",
      archive: "app.tar.gz",
      sources: "sources.json",
    });
    expect(seam.verify).toHaveBeenCalledWith({
      releasePath: "release.json",
      archivePath: "app.tar.gz",
      sourceIndexPath: "sources.json",
    });
    expect(seam.target).toHaveBeenCalledBefore(seam.verify);
    expect(seam.firstInstall).toHaveBeenCalledBefore(seam.verify);
    expect(seam.stage).toHaveBeenCalledWith({ archivePath: "app.tar.gz", descriptor });
    expect(seam.revalidate).toHaveBeenCalledWith(staged);
    expect(seam.activate).toHaveBeenCalledWith(staged, { mode: "first-install" });
    expect(result).toMatchObject({
      version: "0.2.1",
      launched: false,
      executable_path: staged.executablePath,
      bootstrap_version: "1.0.0",
      trusted_key_id: "vellum-linux-2026a",
    });
  });

  it("refuses unsupported hosts and existing installations before reading artifacts or staging", async () => {
    seam.target.mockRejectedValueOnce(new Error("unsupported host"));
    await expect(installLinuxDesktop({ release: "release", archive: "archive", sources: "sources" }))
      .rejects.toThrow(/host/);
    expect(seam.verify).not.toHaveBeenCalled();
    seam.firstInstall.mockRejectedValueOnce(new Error("already installed"));
    await expect(installLinuxDesktop({ release: "release", archive: "archive", sources: "sources" }))
      .rejects.toThrow(/installed/);
    expect(seam.stage).not.toHaveBeenCalled();
  });

  it("never stages unauthenticated input or activates a changed staged candidate", async () => {
    seam.verify.mockRejectedValueOnce(new Error("invalid signature"));
    await expect(installLinuxDesktop({ release: "bad", archive: "app", sources: "sources" }))
      .rejects.toThrow(/signature/);
    expect(seam.stage).not.toHaveBeenCalled();
    seam.verify.mockResolvedValue({ version: "0.2.1" });
    seam.stage.mockResolvedValue({ executablePath: "/home/example/app" });
    seam.revalidate.mockRejectedValueOnce(new Error("staged bytes changed"));
    await expect(installLinuxDesktop({ release: "good", archive: "app", sources: "sources" }))
      .rejects.toThrow(/changed/);
    expect(seam.activate).not.toHaveBeenCalled();
  });
});

describe("Linux desktop bootstrap argument policy", () => {
  it("accepts only the three file flags, help, and version", () => {
    expect(parseLinuxDesktopBootstrapArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseLinuxDesktopBootstrapArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseLinuxDesktopBootstrapArgs([
      "--release",
      "release.json",
      "--archive",
      "app.tar.gz",
      "--sources",
      "sources.json",
    ])).toEqual({
      kind: "install",
      release: "release.json",
      archive: "app.tar.gz",
      sources: "sources.json",
    });
  });

  it.each([
    ["--trust", "attacker.json"],
    ["--keyring", "attacker.json"],
    ["--force", "true"],
    ["--origin", "https://evil.example"],
    ["desktop-install"],
  ])("rejects attacker-controlled option %s", (...args: string[]) => {
    expect(() => parseLinuxDesktopBootstrapArgs(args)).toThrow(/unknown bootstrap option/);
  });
});

describe("Linux desktop bootstrap process", () => {
  it("prints embedded trust identity without reading candidate files", async () => {
    const stdout = capture(process.stdout);
    await runLinuxDesktopBootstrap(["--version"]);
    const envelope = JSON.parse(stdout.text());
    expect(envelope).toEqual({
      ok: true,
      command: "linux-desktop-bootstrap",
      data: linuxDesktopBootstrapIdentity(),
    });
    expect(seam.verify).not.toHaveBeenCalled();
    expect(seam.stage).not.toHaveBeenCalled();
  });

  it("reports structured failure without staging", async () => {
    seam.target.mockRejectedValueOnce(new Error("unsupported host"));
    const stderr = capture(process.stderr);
    await runLinuxDesktopBootstrap([
      "--release",
      "release.json",
      "--archive",
      "app.tar.gz",
      "--sources",
      "sources.json",
    ]);
    expect(process.exitCode).toBe(1);
    const envelope = JSON.parse(stderr.text());
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("linux-desktop-bootstrap");
    expect(envelope.error.type).toBe("LinuxDesktopInstallError");
    expect(envelope.error.message).toMatch(/host/);
    expect(seam.stage).not.toHaveBeenCalled();
  });
});

describe("independent first-install admission against website replacement", () => {
  it("rejects a matching website checksum whose descriptor is not signed by embedded trust and never stages", async () => {
    seam.verify.mockImplementation(async (input) => {
      const actual = await vi.importActual<typeof import("../src/shared/linux-desktop-release-files")>(
        "../src/shared/linux-desktop-release-files",
      );
      return actual.verifyLinuxDesktopReleaseFiles(input);
    });
    const root = await mkdtemp(join(await realpath(tmpdir()), "vellum-command-bootstrap-replace-"));
    roots.push(root);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const sentinel = join(root, "candidate-executed");
    const version = "0.2.1";
    const archiveName = linuxDesktopArchiveName(version);
    const archiveBytes = Buffer.from("#!/bin/sh\nprintf executed > \"$SENTINEL\"\n");
    const archivePath = join(root, archiveName);
    await writeFile(archivePath, archiveBytes);
    await chmod(archivePath, 0o755);
    const attacker = generateKeyPairSync("ed25519");
    const sources = {
      schema: "vellum-command/release-sources/v1",
      product: "Vellum Command",
      version,
      sourceCommit: "a".repeat(40),
      access: "same-download-location",
      files: [{ file: "synthetic-source.tar.gz", bytes: 1, sha256: "b".repeat(64) }],
      binaries: [{ file: archiveName, bytes: archiveBytes.length, sha256: sha256(archiveBytes) }],
    };
    const sourcesPath = join(root, "sources.json");
    await writeFile(sourcesPath, JSON.stringify(sources));
    const descriptor: LinuxDesktopReleaseDescriptor = {
      schema: LINUX_DESKTOP_RELEASE_SCHEMA,
      product: "Vellum Command",
      channel: "alpha",
      version,
      sourceRevision: "a".repeat(40),
      createdAt: "2026-01-01T00:00:00.000Z",
      target: LINUX_DESKTOP_TARGET,
      archive: {
        file: archiveName,
        path: `/linux/x64/${archiveName}`,
        bytes: archiveBytes.length,
        sha256: sha256(archiveBytes),
      },
      sources: {
        path: `/linux/x64/sources/${version}/sources.json`,
        bytes: (await readFile(sourcesPath)).length,
        sha256: sha256(await readFile(sourcesPath)),
      },
      trust: { algorithm: "ed25519", keyId: "attacker-key", keyringRevision: 1 },
    };
    const releasePath = join(root, "release.json");
    await writeFile(
      releasePath,
      JSON.stringify(signLinuxDesktopRelease(descriptor, attacker.privateKey)),
    );
    await expect(installLinuxDesktop({
      release: releasePath,
      archive: archivePath,
      sources: sourcesPath,
      home,
    }, { assertTarget: async () => undefined })).rejects.toThrow(/pinned signing trust|signature/);
    expect(seam.stage).not.toHaveBeenCalled();
    expect(seam.activate).not.toHaveBeenCalled();
    await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, ".local/bin/vellum-command-desktop"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(home, ".vellum-command/state/vellum-command.db"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
