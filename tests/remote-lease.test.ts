import { afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_LEASE_TTL_MS,
  evaluateRemoteLease,
} from "../src/main/vellum/license/remote-lease";
import { remoteLeaseState } from "../src/main/vellum/license/remote-lease-state";
import { licenseFactoryHold } from "../src/main/vellum/license/factory-hold";

const at = (iso: string) => ({ now: () => Date.parse(iso) });

afterEach(() => {
  remoteLeaseState.resetForTests();
  licenseFactoryHold.resetForTests();
});

describe("remote Command Center lease", () => {
  it("admits a fresh check-in inside the 3-day window", () => {
    const decision = evaluateRemoteLease(
      Date.parse("2026-07-28T00:00:00.000Z"),
      at("2026-07-30T12:00:00.000Z"),
    );
    expect(decision).toMatchObject({ ok: true, reason: "remote-lease-ok" });
    expect(REMOTE_LEASE_TTL_MS).toBe(3 * 24 * 60 * 60 * 1_000);
  });

  it("expires after three days without check-in", () => {
    const decision = evaluateRemoteLease(
      Date.parse("2026-07-28T00:00:00.000Z"),
      at("2026-07-31T00:00:00.001Z"),
    );
    expect(decision).toMatchObject({
      ok: false,
      reason: "remote-lease-expired",
    });
  });

  it("treats never-checked-in as never lease", () => {
    expect(evaluateRemoteLease(null, at("2026-07-28T00:00:00.000Z"))).toMatchObject({
      ok: false,
      reason: "remote-lease-never",
    });
  });

  it("notifies subscribers when a stamp advances the check-in", () => {
    let fires = 0;
    const unsub = remoteLeaseState.subscribe(() => {
      fires += 1;
    });
    remoteLeaseState.stamp(1_000);
    remoteLeaseState.stamp(1_000); // no advance
    remoteLeaseState.stamp(2_000);
    expect(fires).toBe(2);
    expect(remoteLeaseState.read()).toBe(2_000);
    unsub();
  });

  it("hydrates without lowering a newer in-memory stamp", () => {
    remoteLeaseState.stamp(5_000);
    remoteLeaseState.hydrate(1_000);
    expect(remoteLeaseState.read()).toBe(5_000);
    remoteLeaseState.hydrate(9_000);
    expect(remoteLeaseState.read()).toBe(9_000);
  });
});

describe("license factory hold sticky latch", () => {
  it("requires operator play after leaving maintenance", () => {
    licenseFactoryHold.set("maintenance");
    expect(licenseFactoryHold.forcesPaused()).toBe(true);
    expect(licenseFactoryHold.requiresOperatorPlay()).toBe(true);
    licenseFactoryHold.set("none");
    expect(licenseFactoryHold.isMaintenance()).toBe(false);
    expect(licenseFactoryHold.requiresOperatorPlay()).toBe(true);
    expect(licenseFactoryHold.forcesPaused()).toBe(true);
    licenseFactoryHold.clearAfterOperatorPlay();
    expect(licenseFactoryHold.forcesPaused()).toBe(false);
  });
});
