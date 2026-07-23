import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { electronSecurityPolicyHealthy } from "../src/main/vellum/electron-security-health";

describe("Electron credential admission health", () => {
  it("fails closed when an offline policy is expired or its runtime mismatches", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vellum-electron-health-"));
    const policyPath = path.join(directory, "policy.json");
    await writeFile(policyPath, JSON.stringify({ reviewedAt: "2026-07-23T00:00:00.000Z", expiresAt: "2026-08-06T00:00:00.000Z", reviewSla: { routineDays: 14 }, electron: { exactVersion: "43.2.0", currentSupportedMajors: [41, 42, 43] } }));
    expect(electronSecurityPolicyHealthy({ policyPath, electronVersion: "43.2.0", now: new Date("2026-07-24T00:00:00.000Z") })).toBe(true);
    expect(electronSecurityPolicyHealthy({ policyPath, electronVersion: "43.1.1", now: new Date("2026-07-24T00:00:00.000Z") })).toBe(false);
    expect(electronSecurityPolicyHealthy({ policyPath, electronVersion: "43.2.0", now: new Date("2026-08-06T00:00:00.000Z") })).toBe(false);
  });
});
