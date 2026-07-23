/** Offline admission gate for primary browser capability credentials. */
import { readFileSync } from "node:fs";
import path from "node:path";

export const electronSecurityPolicyHealthy = (input: {
  readonly policyPath: string;
  readonly electronVersion: string;
  readonly now?: Date;
}): boolean => {
  try {
    const policy = JSON.parse(readFileSync(input.policyPath, "utf8")) as Record<string, unknown>;
    const keys = Object.keys(policy).sort().join(",");
    if (keys !== "electron,expiresAt,provenance,reviewSla,reviewedAt,schemaVersion" || policy.schemaVersion !== 1 || !Array.isArray(policy.provenance) || policy.provenance.length < 3) return false;
    const reviewSla = policy.reviewSla as Record<string, unknown> | undefined;
    const electron = policy.electron as Record<string, unknown> | undefined;
    const audited = electron?.auditedRelease as Record<string, unknown> | undefined;
    if (!reviewSla || !electron || !audited || typeof policy.reviewedAt !== "string" || typeof policy.expiresAt !== "string" || typeof reviewSla.routineDays !== "number" || typeof reviewSla.urgentHours !== "number" || typeof electron.exactVersion !== "string" || !Array.isArray(electron.currentSupportedMajors) || audited.version !== electron.exactVersion || !policy.provenance.every((entry) => typeof (entry as Record<string, unknown>).url === "string" && String((entry as Record<string, unknown>).url).startsWith("https://"))) return false;
    const now = (input.now ?? new Date()).getTime();
    const reviewed = Date.parse(policy.reviewedAt as string);
    const expires = Date.parse(policy.expiresAt as string);
    const routineDays = reviewSla.routineDays;
    const exact = electron.exactVersion;
    const major = /^([0-9]+)\./.exec(input.electronVersion)?.[1];
    return Number.isFinite(reviewed) && Number.isFinite(expires) && Number.isInteger(routineDays) && reviewed <= now && expires > now && expires <= reviewed + routineDays * 86_400_000 && exact === input.electronVersion && electron.currentSupportedMajors.includes(Number(major));
  } catch { return false; }
};

export const packagedElectronSecurityPolicyPath = (resourcesPath: string): string =>
  path.join(resourcesPath, "policy", "electron-security-policy.json");
