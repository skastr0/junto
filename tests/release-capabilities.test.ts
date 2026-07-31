import { describe, expect, it } from "vitest";
import {
  BOX_FLEET_DISABLED_DETAIL,
  DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL,
  LINUX_REMOTE_DEPLOY_DISABLED_DETAIL,
  MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
  SUPPORTED_MANAGED_HOST_PLATFORMS,
  isManagedHostPlatformSupported,
  resolveReleaseCapabilities,
} from "../src/shared/release-capabilities";

describe("RELEASE_CAPABILITIES product surface", () => {
  it("supports only darwin managed hosts in production", () => {
    expect([...SUPPORTED_MANAGED_HOST_PLATFORMS]).toEqual(["darwin"]);
    expect(isManagedHostPlatformSupported("darwin")).toBe(true);
    expect(isManagedHostPlatformSupported("linux")).toBe(false);
    expect(RELEASE_CAPABILITIES.freshRemoteEnrollment).toBe(true);
    expect(RELEASE_CAPABILITIES.managedRemoteDeploy).toBe(true);
    expect(RELEASE_CAPABILITIES.darwinRemoteDeploy).toBe(true);
    expect(RELEASE_CAPABILITIES.linuxRemoteDeploy).toBe(false);
    expect(RELEASE_CAPABILITIES.boxFleet).toBe(false);
    expect(RELEASE_CAPABILITIES.commandCenterTransfer).toBe(true);
    expect("stationProjection" in RELEASE_CAPABILITIES).toBe(false);
  });

  it("is frozen (not ambient-env knobs)", () => {
    expect(Object.isFrozen(RELEASE_CAPABILITIES)).toBe(true);
    expect(() => {
      // @ts-expect-error intentional mutation probe
      RELEASE_CAPABILITIES.managedRemoteDeploy = false;
    }).toThrow();
  });

  it("keeps denial copy for freezes", () => {
    expect(MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL.length).toBeGreaterThan(20);
    expect(DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL).toMatch(/Darwin/i);
    expect(LINUX_REMOTE_DEPLOY_DISABLED_DETAIL).toMatch(/Linux/i);
    expect(BOX_FLEET_DISABLED_DETAIL).toMatch(/Box/i);
  });

  it("re-enables Linux/Box only when unpackaged and explicitly requested", () => {
    const packaged = resolveReleaseCapabilities({
      packaged: true,
      enableLinuxFleet: true,
    });
    expect(packaged.linuxRemoteDeploy).toBe(false);
    expect(packaged.boxFleet).toBe(false);

    const unpackaged = resolveReleaseCapabilities({
      packaged: false,
      enableLinuxFleet: true,
    });
    expect(unpackaged.linuxRemoteDeploy).toBe(true);
    expect(unpackaged.boxFleet).toBe(true);

    const unpackagedDefault = resolveReleaseCapabilities({ packaged: false });
    expect(unpackagedDefault.linuxRemoteDeploy).toBe(false);
    expect(unpackagedDefault.boxFleet).toBe(false);
  });
});
