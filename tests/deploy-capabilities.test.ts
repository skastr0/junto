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

  it("enables managed deploy on Command Center when operator allows (no target platform)", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
    });
    expect(caps.effective.deployRemote).toBe(true);
    expect(caps.detail.deployRemote).toBeUndefined();
  });

  it("enables Linux target package deploy without darwinRemoteDeploy", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
      platform: "linux",
    });
    expect(caps.effective.deployRemote).toBe(true);
  });

  it("still freezes Darwin target when darwinRemoteDeploy is off", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
      platform: "darwin",
    });
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.detail.deployRemote).toMatch(/Darwin/i);
  });

  it("refuses deployment away from Command Center", () => {
    const caps = computeDeployCapabilities({
      stationRole: "remote",
      remoteManagedInstalls: true,
      release: {
        ...RELEASE_CAPABILITIES,
        managedRemoteDeploy: true,
      },
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

  it("deploy requires managed + darwin on darwin targets when both true", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
      platform: "darwin",
      release: {
        ...RELEASE_CAPABILITIES,
        managedRemoteDeploy: true,
        darwinRemoteDeploy: true,
      },
    });
    expect(caps.effective.deployRemote).toBe(true);
  });
});
