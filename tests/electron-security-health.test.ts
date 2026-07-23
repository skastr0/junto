import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  developmentElectronSecurityPolicyPath,
  electronSecurityPolicyHealthy,
} from "../src/main/vellum/electron-security-health";

describe("Electron credential admission health", () => {
  it("resolves the reviewed policy from source and bundled main entries", () => {
    const expected = path.resolve("scripts/electron-security-policy.json");
    const sourceEntry = new URL("../src/main/index.ts", import.meta.url).href;
    const bundledEntry = new URL("../out/main/index.js", import.meta.url).href;

    expect(developmentElectronSecurityPolicyPath(sourceEntry)).toBe(expected);
    expect(developmentElectronSecurityPolicyPath(bundledEntry)).toBe(expected);
  });

  it("fails closed when an offline policy is expired or its runtime mismatches", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vellum-electron-health-"));
    const policyPath = path.join(directory, "policy.json");
    await writeFile(policyPath, JSON.stringify({ reviewedAt: "2026-07-23T00:00:00.000Z", expiresAt: "2026-08-06T00:00:00.000Z", reviewSla: { routineDays: 14 }, electron: { exactVersion: "43.2.0", currentSupportedMajors: [41, 42, 43] } }));
    expect(electronSecurityPolicyHealthy({ policyPath, electronVersion: "43.2.0", now: new Date("2026-07-24T00:00:00.000Z") })).toBe(false);
    expect(electronSecurityPolicyHealthy({ policyPath, electronVersion: "43.1.1", now: new Date("2026-07-24T00:00:00.000Z") })).toBe(false);
    expect(electronSecurityPolicyHealthy({ policyPath, electronVersion: "43.2.0", now: new Date("2026-08-06T00:00:00.000Z") })).toBe(false);
    await writeFile(policyPath, JSON.stringify({ reviewedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2126-01-01T00:00:00.000Z", reviewSla: { routineDays: 99_999 }, electron: { exactVersion: "43.2.0", currentSupportedMajors: [41, 42, 43] } }));
    expect(electronSecurityPolicyHealthy({ policyPath, electronVersion: "43.2.0", now: new Date("2026-07-24T00:00:00.000Z") })).toBe(false);
  });
});
