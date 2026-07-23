/** Offline admission gate. It deliberately delegates all schema rules to the
 * same canonical decoder used by release tooling. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeElectronObservation,
  decodeElectronSecurityPolicy,
  requireElectronObservationAdmission,
  validateElectronObservation,
  validateElectronSecurityPolicy,
} from "../../../scripts/electron-security-policy";

export const electronSecurityPolicyHealthy = (input: {
  readonly policyPath: string;
  readonly electronVersion: string;
  readonly now?: Date;
  readonly observationPath?: string;
  readonly observationHighWaterPath?: string;
}): boolean => {
  try {
    const policy = decodeElectronSecurityPolicy(JSON.parse(readFileSync(input.policyPath, "utf8")));
    validateElectronSecurityPolicy(policy, {
      now: input.now ?? new Date(),
      manifestVersion: policy.electron.exactVersion,
      installedPackageVersion: policy.electron.exactVersion,
      installedRuntimeVersion: input.electronVersion,
    });
    if (input.observationPath !== undefined || input.observationHighWaterPath !== undefined) {
      if (input.observationPath === undefined || input.observationHighWaterPath === undefined) return false;
      const rawPolicy = readFileSync(input.policyPath, "utf8");
      const observation = decodeElectronObservation(JSON.parse(readFileSync(input.observationPath, "utf8")));
      const highWater = decodeElectronObservation(JSON.parse(readFileSync(input.observationHighWaterPath, "utf8")));
      validateElectronObservation(observation, policy, rawPolicy, input.now ?? new Date());
      validateElectronObservation(highWater, policy, rawPolicy, input.now ?? new Date());
      if (JSON.stringify(observation) !== JSON.stringify(highWater)) return false;
      requireElectronObservationAdmission(observation);
    }
    return true;
  } catch { return false; }
};

export const packagedElectronSecurityPolicyPath = (resourcesPath: string): string =>
  path.join(resourcesPath, "policy", "electron-security-policy.json");
/** Source and electron-vite output both live exactly two levels below root. */
export const developmentElectronSecurityPolicyPath = (mainModuleUrl: string): string =>
  path.resolve(
    path.dirname(fileURLToPath(mainModuleUrl)),
    "../../scripts/electron-security-policy.json",
  );
export const packagedElectronObservationPath = (resourcesPath: string): string =>
  path.join(resourcesPath, "policy", "electron-observation.json");
export const packagedElectronObservationHighWaterPath = (resourcesPath: string): string =>
  path.join(resourcesPath, "policy", "electron-observation-high-water.json");
