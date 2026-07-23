/** Offline admission gate. It deliberately delegates all schema rules to the
 * same canonical decoder used by release tooling. */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  decodeElectronSecurityPolicy,
  validateElectronSecurityPolicy,
} from "../../../scripts/electron-security-policy";

export const electronSecurityPolicyHealthy = (input: {
  readonly policyPath: string;
  readonly electronVersion: string;
  readonly now?: Date;
}): boolean => {
  try {
    const policy = decodeElectronSecurityPolicy(JSON.parse(readFileSync(input.policyPath, "utf8")));
    validateElectronSecurityPolicy(policy, {
      now: input.now ?? new Date(),
      manifestVersion: policy.electron.exactVersion,
      installedPackageVersion: policy.electron.exactVersion,
      installedRuntimeVersion: input.electronVersion,
    });
    return true;
  } catch { return false; }
};

export const packagedElectronSecurityPolicyPath = (resourcesPath: string): string =>
  path.join(resourcesPath, "policy", "electron-security-policy.json");
