/**
 * The region screen's two calls into Junto's secret store.
 *
 * A value crosses from the renderer once, on save, and is never sent back by
 * any call: the answer is the secret id, which is what the canvas stores.
 * Input arrives untyped off IPC and is checked here; a refusal is a sentence
 * for the operator, never a throw, and never contains the value.
 */
import type {
  RegionEnvRemoveSecretResult,
  RegionEnvSaveSecretResult,
} from "@shared/ipc";
import { regionSecrets, type RegionSecrets } from "./secret-store";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const saveRegionSecret = (
  input: unknown,
  secrets: RegionSecrets = regionSecrets(),
): RegionEnvSaveSecretResult => {
  if (!isRecord(input) || typeof input.value !== "string") {
    return { ok: false, message: "There is no secret to save." };
  }
  if (input.secretId !== undefined && typeof input.secretId !== "string") {
    return { ok: false, message: "That is not a secret id." };
  }
  // regionId and name are context from the screen. The store keeps neither:
  // an item is found by its id alone, and the canvas says where it is used.
  return secrets.save({
    value: input.value,
    ...(input.secretId === undefined ? {} : { secretId: input.secretId }),
  });
};

export const removeRegionSecret = (
  secretId: unknown,
  secrets: RegionSecrets = regionSecrets(),
): RegionEnvRemoveSecretResult =>
  typeof secretId === "string" ? secrets.remove(secretId) : { ok: true };
