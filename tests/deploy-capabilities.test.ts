import { describe, expect, it } from "vitest";
import { computeDeployCapabilities } from "../src/shared/deploy-capabilities";
import { RELEASE_CAPABILITIES } from "../src/shared/release-capabilities";

describe("computeDeployCapabilities", () => {
  it("fails closed when operator kill-switch is off", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: false,
    });
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.detail.deployRemote).toMatch(/turned off|Settings/i);
  });

  it("enables deploy on Command Center when operator allows", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
    });
    expect(caps.effective.deployRemote).toBe(true);
    expect(caps.detail.deployRemote).toBeUndefined();
  });

  it("enables Linux and Darwin targets under full product surface", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const caps = computeDeployCapabilities({
        stationRole: "command-center",
        remoteManagedInstalls: true,
        platform,
      });
      expect(caps.effective.deployRemote).toBe(true);
    }
  });

  it("refuses deployment away from Command Center", () => {
    const caps = computeDeployCapabilities({
      stationRole: "remote",
      remoteManagedInstalls: true,
      platform: "linux",
    });
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.detail.deployRemote).toMatch(/Command Center/i);
  });

  it("cannot enable deploy when RELEASE freezes managed deploy", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
      release: {
        ...RELEASE_CAPABILITIES,
        managedRemoteDeploy: false,
        darwinRemoteDeploy: true,
      },
    });
    expect(caps.effective.deployRemote).toBe(false);
  });

  it("refuses Darwin target when only darwinRemoteDeploy is frozen", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
      platform: "darwin",
      release: {
        ...RELEASE_CAPABILITIES,
        managedRemoteDeploy: true,
        darwinRemoteDeploy: false,
      },
    });
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.detail.deployRemote).toMatch(/Darwin/i);
  });
});
