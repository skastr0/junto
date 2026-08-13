import { describe, expect, it } from "vitest";
import {
  computeDeployCapabilities,
  releaseAllowsTargetPlatform,
} from "../src/shared/deploy-capabilities";
import {
  LINUX_REMOTE_DEPLOY_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
} from "../src/shared/release-capabilities";

describe("computeDeployCapabilities", () => {
  it("fails closed when operator kill-switch is off", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: false,
    });
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.detail.deployRemote).toMatch(/turned off|Settings/i);
  });

  it("enables Darwin deploy on Command Center when operator allows", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
      platform: "darwin",
    });
    expect(caps.effective.deployRemote).toBe(true);
    expect(caps.detail.deployRemote).toBeUndefined();
    expect(caps.effective.boxFleet).toBe(false);
    expect(caps.release.linuxRemoteDeploy).toBe(false);
  });

  it("refuses Linux managed deploy under production surface", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
      platform: "linux",
    });
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.detail.deployRemote).toMatch(/Linux/i);
  });

  it("refuses deployment away from Command Center", () => {
    const caps = computeDeployCapabilities({
      stationRole: "remote",
      remoteManagedInstalls: true,
      platform: "darwin",
    });
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.detail.deployRemote).toMatch(/Command Center/i);
    expect(caps.effective.boxFleet).toBe(false);
  });

  it("cannot enable deploy when RELEASE freezes managed deploy", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
      release: {
        ...RELEASE_CAPABILITIES,
        managedRemoteDeploy: false,
        darwinRemoteDeploy: true,
        linuxRemoteDeploy: true,
        boxFleet: true,
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
        linuxRemoteDeploy: false,
        boxFleet: false,
      },
    });
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.detail.deployRemote).toMatch(/Darwin/i);
  });

  it("enables Linux and Box when a test opens the full surface", () => {
    const caps = computeDeployCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
      platform: "linux",
      release: {
        ...RELEASE_CAPABILITIES,
        linuxRemoteDeploy: true,
        boxFleet: true,
      },
    });
    expect(caps.effective.deployRemote).toBe(true);
    expect(caps.effective.boxFleet).toBe(true);
  });
});

describe("releaseAllowsTargetPlatform", () => {
  it("freezes Linux and admits Darwin under production", () => {
    expect(RELEASE_CAPABILITIES.linuxRemoteDeploy).toBe(false);
    expect(releaseAllowsTargetPlatform(RELEASE_CAPABILITIES, "linux")).toEqual({
      ok: false,
      detail: LINUX_REMOTE_DEPLOY_DISABLED_DETAIL,
    });
    expect(releaseAllowsTargetPlatform(RELEASE_CAPABILITIES, "darwin").ok).toBe(
      true,
    );
    expect(
      releaseAllowsTargetPlatform(RELEASE_CAPABILITIES, undefined).ok,
    ).toBe(true);
  });
});
