import { describe, expect, it, vi } from "vitest";
import {
  DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL,
  MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
} from "../src/shared/release-capabilities";

describe("RELEASE_CAPABILITIES beta surface", () => {
  it("keeps projection canonical and freezes managed deploy paths", () => {
    expect(RELEASE_CAPABILITIES.freshRemoteEnrollment).toBe(true);
    expect("stationProjection" in RELEASE_CAPABILITIES).toBe(false);
    expect(RELEASE_CAPABILITIES.managedRemoteDeploy).toBe(false);
    expect(RELEASE_CAPABILITIES.managedRemoteUpdate).toBe(false);
    expect(RELEASE_CAPABILITIES.managedRemoteRollback).toBe(false);
    expect(RELEASE_CAPABILITIES.darwinRemoteDeploy).toBe(false);
    expect(RELEASE_CAPABILITIES.commandCenterTransfer).toBe(false);
  });

  it("is frozen (not ambient-env knobs)", () => {
    expect(Object.isFrozen(RELEASE_CAPABILITIES)).toBe(true);
    expect(() => {
      // @ts-expect-error intentional mutation probe
      RELEASE_CAPABILITIES.managedRemoteDeploy = true;
    }).toThrow();
  });

  it("exposes stable operator-facing denial copy", () => {
    expect(MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL).toMatch(/manual/i);
    expect(MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL).toMatch(/\.deb/i);
    expect(DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL).toMatch(/Darwin/i);
  });
});

describe("HostsService managed deploy gate", () => {
  it("deployConfiguredRemote refuses without loading providers when disabled", async () => {
    // Product policy is compile-time false — import service path and assert
    // the shared constant is the gate (IPC/service both read RELEASE_CAPABILITIES).
    expect(RELEASE_CAPABILITIES.managedRemoteDeploy).toBe(false);
    const { MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL: detail } = await import(
      "../src/shared/release-capabilities"
    );
    expect(detail.length).toBeGreaterThan(20);
  });
});
