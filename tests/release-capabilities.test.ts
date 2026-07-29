import { describe, expect, it } from "vitest";
import {
  DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL,
  MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
} from "../src/shared/release-capabilities";

describe("RELEASE_CAPABILITIES product surface", () => {
  it("enables every deploy product path", () => {
    expect(RELEASE_CAPABILITIES.freshRemoteEnrollment).toBe(true);
    expect(RELEASE_CAPABILITIES.managedRemoteDeploy).toBe(true);
    expect(RELEASE_CAPABILITIES.darwinRemoteDeploy).toBe(true);
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

  it("keeps denial copy for test/operator freezes", () => {
    expect(MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL.length).toBeGreaterThan(20);
    expect(DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL).toMatch(/Darwin/i);
  });
});
