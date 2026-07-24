import { describe, expect, it } from "vitest";
import { computeInstallCapabilities } from "../src/shared/install-capabilities";
import { RELEASE_CAPABILITIES } from "../src/shared/release-capabilities";

describe("computeInstallCapabilities", () => {
  it("fails closed by default (operator off, managed deploy frozen)", () => {
    const caps = computeInstallCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: false,
    });
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.effective.installPluginRemote).toBe(false);
    // local plugin still CC-gated; operator off does not block local on CC
    expect(caps.effective.installPluginLocal).toBe(
      RELEASE_CAPABILITIES.pluginInstall,
    );
    // route-token admin requires kill-switch on
    expect(caps.effective.routeTokenAdmin).toBe(false);
    expect(caps.detail.installPluginRemote).toMatch(/turned off/i);
    expect(caps.detail.routeTokenAdmin).toMatch(/turned off/i);
  });

  it("enables remote plugin + route admin when operator opts in on CC", () => {
    const caps = computeInstallCapabilities({
      stationRole: "command-center",
      remoteManagedInstalls: true,
    });
    expect(caps.effective.installPluginRemote).toBe(
      RELEASE_CAPABILITIES.pluginInstall,
    );
    expect(caps.effective.routeTokenAdmin).toBe(
      RELEASE_CAPABILITIES.routeTokens,
    );
    // managed deploy still frozen by RELEASE in this line
    expect(caps.effective.deployRemote).toBe(false);
    expect(caps.detail.deployRemote).toBeDefined();
  });

  it("refuses remote ops and local plugin when not command-center", () => {
    const caps = computeInstallCapabilities({
      stationRole: "remote",
      remoteManagedInstalls: true,
    });
    expect(caps.effective.installPluginRemote).toBe(false);
    expect(caps.effective.installPluginLocal).toBe(false);
    expect(caps.effective.routeTokenAdmin).toBe(false);
    expect(caps.detail.routeTokenAdmin).toMatch(/Command Center/i);
    expect(caps.detail.installPluginLocal).toMatch(/Command Center/i);
  });

  it("cannot enable deploy when RELEASE freezes managed deploy", () => {
    const caps = computeInstallCapabilities({
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
    const caps = computeInstallCapabilities({
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
