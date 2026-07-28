import { describe, expect, it } from "vitest";
import { computeDeployCapabilities } from "../src/shared/deploy-capabilities";
import { RELEASE_CAPABILITIES } from "../src/shared/release-capabilities";

describe("computeDeployCapabilities", () => {
  it("fails closed by default when managed deployment is release-frozen", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: false,
    });
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.detail.deployRemote).toBeDefined();
  });

  it("does not let the operator override a release-frozen deployment", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
    });
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.detail.deployRemote).toBeDefined();
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

  it("deploy requires managed + darwin on darwin when both true", () => {
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
