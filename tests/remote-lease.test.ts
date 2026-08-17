/**
 * FLEET-P3 — deterministic Remote check-in lease matrix (pure law + state).
 *
 * Injected clocks only — no real sleeps. Three-day TTL is never weakened.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_LEASE_TTL_MS,
  evaluateRemoteLease,
  pickNewestCheckInMs,
  type RemoteLeaseClock,
} from "../src/main/vellum/license/remote-lease";
import { remoteLeaseState } from "../src/main/vellum/license/remote-lease-state";
import {
  mayRenewRemoteLease,
  REMOTE_LEASE_NON_RENEWAL_OPS,
  REMOTE_LEASE_RENEWAL_OPS,
} from "../src/main/vellum/license/remote-lease-renewal";
import { licenseFactoryHold } from "../src/main/vellum/license/factory-hold";

const clockAt = (ms: number): RemoteLeaseClock => ({ now: () => ms });
const at = (iso: string): RemoteLeaseClock => clockAt(Date.parse(iso));

const CHECK_IN = Date.parse("2026-07-28T00:00:00.000Z");
const EXPIRES = CHECK_IN + REMOTE_LEASE_TTL_MS;

afterEach(() => {
  remoteLeaseState.resetForTests();
  licenseFactoryHold.resetForTests();
});

describe("remote Command Center lease — evaluate matrix", () => {
  it("never-checked-in is remote-lease-never (no check-in)", () => {
    expect(evaluateRemoteLease(null, at("2026-07-28T00:00:00.000Z"))).toEqual({
      ok: false,
      reason: "remote-lease-never",
      expiresAtMs: null,
    });
    expect(evaluateRemoteLease(undefined, clockAt(0))).toMatchObject({
      ok: false,
      reason: "remote-lease-never",
    });
  });

  it("admits a fresh check-in inside the 3-day window", () => {
    const decision = evaluateRemoteLease(
      CHECK_IN,
      at("2026-07-30T12:00:00.000Z"),
    );
    expect(decision).toEqual({
      ok: true,
      reason: "remote-lease-ok",
      expiresAtMs: EXPIRES,
    });
    expect(REMOTE_LEASE_TTL_MS).toBe(3 * 24 * 60 * 60 * 1_000);
  });

  it("is still ok one millisecond before expiry", () => {
    expect(evaluateRemoteLease(CHECK_IN, clockAt(EXPIRES - 1))).toEqual({
      ok: true,
      reason: "remote-lease-ok",
      expiresAtMs: EXPIRES,
    });
  });

  it("is still ok at exact expiry (inclusive upper bound)", () => {
    expect(evaluateRemoteLease(CHECK_IN, clockAt(EXPIRES))).toEqual({
      ok: true,
      reason: "remote-lease-ok",
      expiresAtMs: EXPIRES,
    });
  });

  it("expires one millisecond after the three-day deadline", () => {
    expect(evaluateRemoteLease(CHECK_IN, clockAt(EXPIRES + 1))).toEqual({
      ok: false,
      reason: "remote-lease-expired",
      expiresAtMs: EXPIRES,
    });
  });

  it("treats non-finite check-in as never", () => {
    expect(evaluateRemoteLease(Number.NaN, clockAt(1))).toMatchObject({
      reason: "remote-lease-never",
    });
  });

  it("treats non-positive ttl as expired when a stamp exists", () => {
    expect(evaluateRemoteLease(CHECK_IN, clockAt(CHECK_IN), 0)).toMatchObject({
      ok: false,
      reason: "remote-lease-expired",
    });
  });
});

describe("remote lease — clock jumps", () => {
  it("backward wall-clock jump re-admits an otherwise-expired stamp", () => {
    // Stamp as if check-in was recent relative to a jumped-back clock.
    const stamp = Date.parse("2026-08-01T00:00:00.000Z");
    const jumpedBack = Date.parse("2026-07-29T00:00:00.000Z");
    expect(evaluateRemoteLease(stamp, clockAt(jumpedBack))).toMatchObject({
      ok: true,
      reason: "remote-lease-ok",
    });
  });

  it("forward wall-clock jump past deadline expires the lease", () => {
    const stamp = Date.parse("2026-07-28T00:00:00.000Z");
    const jumpedForward = stamp + REMOTE_LEASE_TTL_MS + 1;
    expect(evaluateRemoteLease(stamp, clockAt(jumpedForward))).toMatchObject({
      ok: false,
      reason: "remote-lease-expired",
    });
  });
});

describe("remote lease — restart hydration (newest valid fact)", () => {
  it("pickNewestCheckInMs chooses the newest finite positive stamp", () => {
    const pairing = Date.parse("2026-07-28T00:00:00.000Z");
    const projection = Date.parse("2026-07-29T12:00:00.000Z");
    expect(pickNewestCheckInMs(pairing, projection, null, undefined, -1)).toBe(
      projection,
    );
    expect(pickNewestCheckInMs(null, undefined, Number.NaN)).toBeNull();
  });

  it("hydrate from pairing + projection seeds the newest without lowering memory", () => {
    const pairing = 1_000;
    const projection = 5_000;
    remoteLeaseState.hydrate(pickNewestCheckInMs(pairing, projection));
    expect(remoteLeaseState.read()).toBe(5_000);
    // Restart path must not clobber a newer mid-session stamp.
    remoteLeaseState.stamp(9_000);
    remoteLeaseState.hydrate(pickNewestCheckInMs(pairing, projection));
    expect(remoteLeaseState.read()).toBe(9_000);
  });

  it("hydrates without lowering a newer in-memory stamp", () => {
    remoteLeaseState.stamp(5_000);
    remoteLeaseState.hydrate(1_000);
    expect(remoteLeaseState.read()).toBe(5_000);
    remoteLeaseState.hydrate(9_000);
    expect(remoteLeaseState.read()).toBe(9_000);
  });

  it("rejects non-finite hydrate/stamp inputs", () => {
    remoteLeaseState.hydrate(Number.NaN);
    remoteLeaseState.hydrate(-1);
    remoteLeaseState.stamp(0);
    remoteLeaseState.stamp(Number.POSITIVE_INFINITY);
    expect(remoteLeaseState.read()).toBeNull();
  });
});

describe("remote lease — mid-session stamp and subscribers", () => {
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

  it("mid-session stamp extends evaluate deadline under a pinned clock", () => {
    const t0 = Date.parse("2026-07-28T00:00:00.000Z");
    remoteLeaseState.stamp(t0);
    const nearExpiry = t0 + REMOTE_LEASE_TTL_MS - 1;
    expect(evaluateRemoteLease(remoteLeaseState.read(), clockAt(nearExpiry))).toMatchObject({
      ok: true,
    });
    // Renew with a later check-in while still inside the old window.
    const renewed = t0 + REMOTE_LEASE_TTL_MS - 60_000;
    remoteLeaseState.stamp(renewed);
    const afterOldDeadline = t0 + REMOTE_LEASE_TTL_MS + 1;
    // Old deadline would expire; renewed stamp keeps access under the same clock.
    expect(evaluateRemoteLease(t0, clockAt(afterOldDeadline))).toMatchObject({
      ok: false,
      reason: "remote-lease-expired",
    });
    expect(
      evaluateRemoteLease(remoteLeaseState.read(), clockAt(afterOldDeadline)),
    ).toMatchObject({ ok: true, reason: "remote-lease-ok" });
  });
});

describe("remote lease — renewal inventory (no Dodo)", () => {
  it("ties stamp eligibility to paired check-in inventory", () => {
    expect(mayRenewRemoteLease("status", { paired: false })).toBe(false);
    expect(mayRenewRemoteLease("project", { paired: true })).toBe(true);
  });

  it("renewal ops never include customer/Dodo validation surfaces", () => {
    expect([...REMOTE_LEASE_RENEWAL_OPS]).toEqual([
      "pair",
      "configure",
      "project",
      "status",
    ]);
    expect([...REMOTE_LEASE_NON_RENEWAL_OPS]).toEqual(["report"]);
    for (const op of REMOTE_LEASE_RENEWAL_OPS) {
      expect(op).not.toMatch(/dodo|activate|portal|validate/i);
    }
  });
});

describe("license factory hold sticky latch", () => {
  it("requires operator play after leaving maintenance (return-to-full latch)", () => {
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

  it("idempotent maintenance observations keep sticky latch set", () => {
    licenseFactoryHold.set("maintenance");
    licenseFactoryHold.set("maintenance");
    licenseFactoryHold.set("maintenance");
    expect(licenseFactoryHold.requiresOperatorPlay()).toBe(true);
    licenseFactoryHold.set("none");
    expect(licenseFactoryHold.requiresOperatorPlay()).toBe(true);
  });
});
