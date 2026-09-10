import { afterEach, describe, expect, it, vi } from "vitest";
const seam = vi.hoisted(() => ({
  verify: vi.fn(), stage: vi.fn(), revalidate: vi.fn(), activate: vi.fn(), target: vi.fn(), firstInstall: vi.fn(),
}));
vi.mock("../src/main/vellum/update/linux-target", () => ({ assertCurrentLinuxDesktopTarget: seam.target }));
vi.mock("../src/shared/linux-desktop-release-files", () => ({ verifyLinuxDesktopReleaseFiles: seam.verify }));
vi.mock("../src/main/vellum/update/linux-install", () => ({
  stageLinuxDesktopRelease: seam.stage,
  revalidateLinuxDesktopRelease: seam.revalidate,
  activateLinuxDesktopRelease: seam.activate,
  assertLinuxDesktopFirstInstallAvailable: seam.firstInstall,
}));
import { installLinuxDesktop } from "../src/cli/commands/desktop-install";

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("Linux desktop first-install CLI", () => {
  it("uses authenticated inputs and the shared create-only transaction without launching", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const descriptor = { version: "0.2.1" };
    const staged = { executablePath: "/home/example/.local/opt/vellum-command-alpha/0.2.1-hash/vellum-command", archiveSha256: "a".repeat(64) };
    seam.verify.mockResolvedValue(descriptor);
    seam.stage.mockResolvedValue(staged);
    seam.revalidate.mockResolvedValue(undefined);
    seam.activate.mockResolvedValue(undefined);
    const result = await installLinuxDesktop({ release: "release.json", archive: "app.tar.gz", sources: "sources.json" });
    expect(seam.verify).toHaveBeenCalledWith({ releasePath: "release.json", archivePath: "app.tar.gz", sourceIndexPath: "sources.json" });
    expect(seam.target).toHaveBeenCalledBefore(seam.verify);
    expect(seam.firstInstall).toHaveBeenCalledBefore(seam.verify);
    expect(seam.stage).toHaveBeenCalledWith({ archivePath: "app.tar.gz", descriptor });
    expect(seam.revalidate).toHaveBeenCalledWith(staged);
    expect(seam.activate).toHaveBeenCalledWith(staged, { mode: "first-install" });
    expect(result).toMatchObject({ version: "0.2.1", launched: false, executable_path: staged.executablePath });
  });
  it("refuses unsupported hosts and existing installations before reading artifacts or staging", async () => {
    seam.target.mockRejectedValueOnce(new Error("unsupported host"));
    await expect(installLinuxDesktop({ release: "release", archive: "archive", sources: "sources" })).rejects.toThrow(/host/);
    expect(seam.verify).not.toHaveBeenCalled();
    seam.firstInstall.mockRejectedValueOnce(new Error("already installed"));
    await expect(installLinuxDesktop({ release: "release", archive: "archive", sources: "sources" })).rejects.toThrow(/installed/);
    expect(seam.stage).not.toHaveBeenCalled();
  });
  it("never stages unauthenticated input or activates a changed staged candidate", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    seam.verify.mockRejectedValueOnce(new Error("invalid signature"));
    await expect(installLinuxDesktop({ release: "bad", archive: "app", sources: "sources" })).rejects.toThrow(/signature/);
    expect(seam.stage).not.toHaveBeenCalled();
    seam.verify.mockResolvedValue({ version: "0.2.1" });
    seam.stage.mockResolvedValue({ executablePath: "/home/example/app" });
    seam.revalidate.mockRejectedValueOnce(new Error("staged bytes changed"));
    await expect(installLinuxDesktop({ release: "good", archive: "app", sources: "sources" })).rejects.toThrow(/changed/);
    expect(seam.activate).not.toHaveBeenCalled();
  });
});
