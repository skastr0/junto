import { describe, expect, it, vi } from "vitest";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import { TermPlane } from "../src/main/vellum/term/plane";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const makePlane = () => {
  const processes = makeFakeTerminalProcessAuthority(() => ({
    pid: undefined,
    exitOnSignal: "SIGTERM",
  }));
  const host = new LocalSessionHost(processes.authority, {
    killGraceMs: 5,
    shutdownGraceMs: 5,
    lateExitGraceMs: 5,
  });
  return { host, plane: new TermPlane(host), processes };
};

describe("TermPlane license suspension", () => {
  it("monotonically closes router and control admission without stopping local PTYs", async () => {
    const { host, plane, processes } = makePlane();
    await plane.router.create({ bindingId: "already-running", hostId: "local" });
    const shutdownAll = vi.spyOn(host, "shutdownAll");
    const controlBeginShutdown = vi.fn();
    (
      plane as unknown as {
        control: { beginShutdown: () => void };
      }
    ).control = { beginShutdown: controlBeginShutdown };
    const productAutomationSuspend = vi.fn();
    plane.bindProductAutomationSuspension({
      suspend: productAutomationSuspend,
    });

    plane.suspendForLicenseRevocation();
    plane.suspendForLicenseRevocation();

    expect(shutdownAll).not.toHaveBeenCalled();
    expect(processes.controllers[0]?.signals).toEqual([]);
    expect(host.runningCount()).toBe(1);
    expect(controlBeginShutdown).toHaveBeenCalledTimes(1);
    expect(productAutomationSuspend).toHaveBeenCalledTimes(1);
    await expect(
      plane.router.create({ bindingId: "late", hostId: "local" }),
    ).rejects.toThrow(/stopping/);
    await expect(plane.start()).rejects.toThrow(/license revocation/);
  });

  it("still signals and drains retained local PTYs on normal quit", async () => {
    const { plane, processes } = makePlane();
    await plane.router.create({ bindingId: "retained-until-quit", hostId: "local" });

    plane.suspendForLicenseRevocation();
    expect(processes.controllers[0]?.signals).toEqual([]);

    await expect(plane.drainOnQuit("app_quit")).resolves.toMatchObject({
      clean: true,
      local: { clean: true, stragglers: [] },
      retainedLabels: [],
    });
    expect(processes.controllers[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("immediately suspends product automation bound after revocation without touching the PTY", async () => {
    const { plane, processes } = makePlane();
    await plane.router.create({
      bindingId: "retained",
      hostId: "local",
    });
    plane.suspendForLicenseRevocation();

    const suspend = vi.fn();
    plane.bindProductAutomationSuspension({ suspend });

    expect(suspend).toHaveBeenCalledTimes(1);
    expect(processes.controllers[0]?.signals).toEqual([]);
  });
});
