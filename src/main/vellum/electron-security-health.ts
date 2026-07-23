/** Offline admission gate for primary browser capability credentials. */
import { readFileSync } from "node:fs";
import path from "node:path";

export const electronSecurityPolicyHealthy = (input: {
  readonly policyPath: string;
  readonly electronVersion: string;
  readonly now?: Date;
}): boolean => {
  try {
    const policy = JSON.parse(readFileSync(input.policyPath, "utf8")) as {
      reviewedAt?: unknown; expiresAt?: unknown; reviewSla?: { routineDays?: unknown }; electron?: { exactVersion?: unknown; currentSupportedMajors?: unknown };
    };
    const now = (input.now ?? new Date()).getTime();
    const reviewed = typeof policy.reviewedAt === "string" ? Date.parse(policy.reviewedAt) : NaN;
    const expires = typeof policy.expiresAt === "string" ? Date.parse(policy.expiresAt) : NaN;
    const routineDays = policy.reviewSla?.routineDays;
    const exact = policy.electron?.exactVersion;
    const major = /^([0-9]+)\./.exec(input.electronVersion)?.[1];
    return Number.isFinite(reviewed) && Number.isFinite(expires) && typeof routineDays === "number" && Number.isInteger(routineDays) && reviewed <= now && expires > now && expires <= reviewed + routineDays * 86_400_000 && exact === input.electronVersion && Array.isArray(policy.electron?.currentSupportedMajors) && policy.electron.currentSupportedMajors.includes(Number(major));
  } catch { return false; }
};

export const packagedElectronSecurityPolicyPath = (resourcesPath: string): string =>
  path.join(resourcesPath, "policy", "electron-security-policy.json");
