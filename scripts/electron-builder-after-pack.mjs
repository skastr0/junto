import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  flipFuses,
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from "@electron/fuses";

const POLICY_PATH = fileURLToPath(
  new URL("./package-security-policy.json", import.meta.url),
);

const libraryFuseNames = () =>
  Object.keys(FuseV1Options)
    .filter((name) => Number.isNaN(Number(name)))
    .sort((left, right) => FuseV1Options[left] - FuseV1Options[right]);

const loadPolicy = async () => {
  const policy = JSON.parse(await readFile(POLICY_PATH, "utf8"));
  if (
    typeof policy !== "object" ||
    policy === null ||
    typeof policy.productName !== "string" ||
    typeof policy.fuses !== "object" ||
    policy.fuses === null
  ) {
    throw new Error("invalid package security policy");
  }

  const expectedNames = libraryFuseNames();
  const configuredNames = Object.keys(policy.fuses).sort(
    (left, right) =>
      expectedNames.indexOf(left) - expectedNames.indexOf(right),
  );
  if (
    configuredNames.length !== expectedNames.length ||
    configuredNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      `package security policy must configure every known Electron fuse exactly once; library=${expectedNames.join(",")} policy=${configuredNames.join(",")}`,
    );
  }
  for (const name of expectedNames) {
    if (typeof policy.fuses[name] !== "boolean") {
      throw new Error(`package security policy fuse ${name} must be boolean`);
    }
  }
  return policy;
};

const assertFuseWire = (wire, policy) => {
  if (wire.version !== FuseVersion.V1) {
    throw new Error(`unexpected Electron fuse version ${wire.version}`);
  }
  const names = libraryFuseNames();
  const wireIndexes = Object.keys(wire)
    .filter((key) => /^\d+$/.test(key))
    .map(Number)
    .sort((left, right) => left - right);
  const expectedIndexes = names.map((name) => FuseV1Options[name]);
  if (
    wireIndexes.length !== expectedIndexes.length ||
    wireIndexes.some((value, index) => value !== expectedIndexes[index])
  ) {
    throw new Error(
      `Electron fuse wire does not exactly match the known fuse set; wire=${wireIndexes.join(",")} expected=${expectedIndexes.join(",")}`,
    );
  }
  for (const name of names) {
    const index = FuseV1Options[name];
    const expected = policy.fuses[name]
      ? FuseState.ENABLE
      : FuseState.DISABLE;
    if (wire[index] !== expected) {
      throw new Error(
        `Electron fuse ${name} mismatch after flip: got ${wire[index]} want ${expected}`,
      );
    }
  }
};

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    throw new Error(
      `Vellum package fuse policy is currently defined only for macOS, not ${context.electronPlatformName}`,
    );
  }

  const policy = await loadPolicy();
  const productFilename = context.packager.appInfo.productFilename;
  if (productFilename !== policy.productName) {
    throw new Error(
      `packaged product name mismatch: got ${productFilename} want ${policy.productName}`,
    );
  }
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);
  await access(appPath);

  const fuseConfig = {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    strictlyRequireAllFuses: true,
  };
  for (const name of libraryFuseNames()) {
    // The trusted renderer still loads from file://. Its standard+secure custom
    // scheme migration must land before file protocol privileges can be disabled.
    fuseConfig[FuseV1Options[name]] = policy.fuses[name];
  }

  const sentinelCount = await flipFuses(appPath, fuseConfig);
  if (sentinelCount < 1 || sentinelCount > 2) {
    throw new Error(
      `unexpected Electron fuse sentinel count ${sentinelCount}`,
    );
  }
  assertFuseWire(await getCurrentFuseWire(appPath), policy);
}
