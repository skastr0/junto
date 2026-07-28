import { describe, expect, it } from "vitest";
import {
  REMOTE_LEASE_TTL_MS,
  evaluateRemoteLease,
} from "../src/main/vellum/license/remote-lease";

const at = (iso: string) => ({ now: () => Date.parse(iso) });

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

  it("treats never-checked-in as expired lease", () => {
    expect(evaluateRemoteLease(null, at("2026-07-28T00:00:00.000Z"))).toMatchObject({
      ok: false,
      reason: "remote-lease-never",
    });
  });
});
