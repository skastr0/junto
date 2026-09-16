import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinuxDesktopActivationError } from "../src/main/vellum-command/update/linux-install";
import {
  installLinuxDesktop,
  linuxDesktopBootstrapIdentity,
  parseLinuxDesktopBootstrapArgs,
  runLinuxDesktopBootstrap,
} from "../src/main/vellum-command/update/linux-first-install";
import { linuxDesktopBootstrapReleaseAssets } from "../scripts/prepare-linux-desktop-bootstrap-release";

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

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = undefined;
});

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

  it.each([false, true] as const)(
    "serializes activation failures with activated=%s and matching recovery guidance",
    async (activated) => {
      seam.verify.mockResolvedValue({ version: "0.2.1" });
      seam.stage.mockResolvedValue({
        executablePath: "/home/example/.local/opt/vellum-command-alpha/0.2.1-hash/vellum-command",
        generationPath: "/home/example/.local/opt/vellum-command-alpha/0.2.1-hash",
        archiveSha256: "a".repeat(64),
      });
      seam.revalidate.mockResolvedValue(undefined);
      seam.activate.mockRejectedValueOnce(
        new LinuxDesktopActivationError("activation boundary reached", activated),
      );
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
      expect(envelope.error.type).toBe("LinuxDesktopInstallError");
      expect(envelope.error.details.activated).toBe(activated);
      if (activated) {
        expect(envelope.error.details.next_step).toMatch(/already published/);
        expect(envelope.error.details.next_step).not.toMatch(/Obtain the independently authenticated bootstrap/);
      } else {
        expect(envelope.error.details.next_step).toMatch(/Obtain the independently authenticated bootstrap/);
        expect(envelope.error.details.next_step).not.toMatch(/already published/);
      }
    },
  );
});

describe("Linux desktop bootstrap publication contract", () => {
  it("requires relink object, Bun notices, source archive, and non-latest verified tags", async () => {
    expect(linuxDesktopBootstrapReleaseAssets()).toEqual([
      "vellum-command-desktop-bootstrap-linux-x64",
      "vellum-command-desktop-bootstrap-linux-x64.sha256",
      "vellum-command-desktop-bootstrap-linux-x64.attestation.jsonl",
      "vellum-command-desktop-bootstrap-linux-x64-relink.js",
      "vellum-command-desktop-bootstrap-linux-x64-relink.json",
      "vellum-command-desktop-bootstrap-linux-x64-relink-notices.txt",
      "vellum-command-desktop-bootstrap-linux-x64-bun-notices.tar.gz",
      "Junto-linux-desktop-bootstrap-1.0.0-source.tar.gz",
      "RELINK.md",
    ]);
    const workflow = await readFile(
      new URL("../.github/workflows/linux-desktop-bootstrap.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("vellum-command-desktop-bootstrap-linux-x64-relink.js");
    expect(workflow).toContain("vellum-command-desktop-bootstrap-linux-x64-bun-notices.tar.gz");
    expect(workflow).toContain("--verify-tag");
    expect(workflow).toContain("--latest=false");
    expect(workflow).toContain('sourceCommit // ""');
  });
});
