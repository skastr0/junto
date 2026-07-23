import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  decodeElectronSecurityPolicy,
  validateElectronSecurityPolicy,
} from "../scripts/electron-security-policy";

const loadPolicy = async () => decodeElectronSecurityPolicy(JSON.parse(
  await readFile(new URL("../scripts/electron-security-policy.json", import.meta.url), "utf8"),
));

const validInput = {
  now: new Date("2026-07-23T12:00:00.000Z"),
  manifestVersion: "43.2.0",
  installedPackageVersion: "43.2.0",
  installedRuntimeVersion: "43.2.0",
};

describe("Electron release-freshness policy", () => {
  it("pins the audited current release with official provenance and explicit review SLAs", async () => {
    const policy = await loadPolicy();
    expect(policy.electron).toMatchObject({
      exactVersion: "43.2.0",
      minimumSupportedMajor: 41,
      currentSupportedMajors: [41, 42, 43],
      auditedRelease: { version: "43.2.0" },
    });
    expect(policy.reviewSla).toEqual({ routineDays: 14, urgentHours: 24 });
    expect(policy.provenance.map((source) => source.url)).toEqual(expect.arrayContaining([
      "https://www.electronjs.org/docs/latest/tutorial/electron-timelines",
      "https://releases.electronjs.org/releases.json",
      "https://releases.electronjs.org/release/v43.2.0",
    ]));
    expect(() => validateElectronSecurityPolicy(policy, validInput)).not.toThrow();
  });

  it("fails closed for expired reviews, missing provenance, unsupported majors, and stale installed artifacts", async () => {
    const policy = await loadPolicy();
    expect(() => validateElectronSecurityPolicy(policy, { ...validInput, now: new Date("2026-08-06T00:00:00.000Z") })).toThrow(/expired/u);
    expect(() => validateElectronSecurityPolicy({ ...policy, provenance: policy.provenance.slice(1) }, validInput)).toThrow(/missing required official/u);
    expect(() => validateElectronSecurityPolicy({ ...policy, electron: { ...policy.electron, currentSupportedMajors: [40, 41, 42], minimumSupportedMajor: 40 } }, validInput)).toThrow(/unsupported/u);
    expect(() => validateElectronSecurityPolicy(policy, { ...validInput, installedRuntimeVersion: "43.1.1" })).toThrow(/expected audited 43\.2\.0/u);
    expect(() => validateElectronSecurityPolicy({ ...policy, reviewedAt: "2026-07-24T00:00:00.000Z" }, validInput)).toThrow(/future/u);
    expect(() => validateElectronSecurityPolicy({ ...policy, expiresAt: "2026-08-07T00:00:00.000Z" }, validInput)).toThrow(/expired/u);
    expect(() => validateElectronSecurityPolicy({ ...policy, electron: { ...policy.electron, auditedRelease: { ...policy.electron.auditedRelease, publishedAt: "2026-07-24T00:00:00.000Z" } } }, validInput)).toThrow(/after the policy review/u);
  });

  it("rejects non-canonical policy structures and non-official provenance", () => {
    expect(() => decodeElectronSecurityPolicy({ schemaVersion: 1 })).toThrow(/keys must be exactly/u);
    expect(() => decodeElectronSecurityPolicy({
      schemaVersion: 1,
      reviewedAt: "2026-07-23T00:00:00.000Z",
      expiresAt: "2026-08-06T00:00:00.000Z",
      reviewSla: { routineDays: 14, urgentHours: 24 },
      electron: { exactVersion: "43.2.0", minimumSupportedMajor: 41, currentSupportedMajors: [41, 42, 43], auditedRelease: { version: "43.2.0", publishedAt: "2026-07-21T16:00:22.000Z", url: "https://releases.electronjs.org/release/v43.2.0" } },
      provenance: [{ url: "https://example.test/releases", purpose: "forged" }, { url: "https://releases.electronjs.org/releases.json", purpose: "release index" }, { url: "https://releases.electronjs.org/release/v43.2.0", purpose: "release" }],
    })).toThrow(/official Electron HTTPS/u);
  });
});
