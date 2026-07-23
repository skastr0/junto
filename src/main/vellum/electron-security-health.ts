/** Offline admission gate. It deliberately delegates all schema rules to the
 * same canonical decoder used by release tooling. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  decodeElectronSecurityPolicy,
  validateElectronSecurityPolicy,
} from "../../../scripts/electron-security-policy";

export const electronSecurityPolicyHealthy = (input: {
  readonly policyPath: string;
  readonly electronVersion: string;
  readonly now?: Date;
  readonly observationPath?: string;
}): boolean => {
  try {
    const policy = decodeElectronSecurityPolicy(JSON.parse(readFileSync(input.policyPath, "utf8")));
    validateElectronSecurityPolicy(policy, {
      now: input.now ?? new Date(),
      manifestVersion: policy.electron.exactVersion,
      installedPackageVersion: policy.electron.exactVersion,
      installedRuntimeVersion: input.electronVersion,
    });
    if (input.observationPath !== undefined) {
      const observation = JSON.parse(readFileSync(input.observationPath, "utf8")) as Record<string, unknown>;
      const hash = createHash("sha256").update(readFileSync(input.policyPath, "utf8")).digest("hex");
      if (observation.schemaVersion !== 1 || observation.policyVersion !== policy.electron.exactVersion || observation.policyHash !== hash || observation.disposition !== "current" || observation.overdue !== false || typeof observation.dueAt !== "string" || Date.parse(observation.dueAt) !== Date.parse(observation.dueAt)) return false;
    }
    return true;
  } catch { return false; }
};

export const packagedElectronSecurityPolicyPath = (resourcesPath: string): string =>
  path.join(resourcesPath, "policy", "electron-security-policy.json");
export const packagedElectronObservationPath = (resourcesPath: string): string =>
  path.join(resourcesPath, "policy", "electron-observation.json");
