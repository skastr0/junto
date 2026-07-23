import { access, chmod, readFile } from "node:fs/promises";
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
  const platform = context.electronPlatformName;
  const policy = await loadPolicy();
  const productName = context.packager.appInfo.productName;
  const productFilename = context.packager.appInfo.productFilename;
  if (productName !== policy.productName) {
    throw new Error(
      `packaged product name mismatch: got ${productName} want ${policy.productName}`,
    );
  }
  const resourceDirectory =
    platform === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources", "bin")
      : platform === "linux"
        ? path.join(context.appOutDir, "resources", "bin")
        : null;
  if (resourceDirectory === null) {
    throw new Error(`unsupported Vellum package platform: ${platform}`);
  }
  for (const name of ["vellum", "vellum-browser", "unix-peer-pid.py"]) {
    const resource = path.join(resourceDirectory, name);
    await access(resource);
    await chmod(resource, 0o755);
  }
  if (platform === "linux") {
    for (const name of [
      "vellum-release-installer",
      "vellum-release-bridge",
    ]) {
      await chmod(path.join(resourceDirectory, name), 0o755);
    }
    await chmod(path.join(context.appOutDir, "chrome-sandbox"), 0o755);
    await chmod(path.join(context.appOutDir, "resources", "apparmor-profile"), 0o644);
    await chmod(path.join(context.appOutDir, "resources", "systemd", "vellum-remote-launch-v1"), 0o755);
    await chmod(path.join(context.appOutDir, "resources", "systemd", "vellum-remote.service"), 0o644);
  }
  const executablePath =
    platform === "darwin"
      ? path.join(context.appOutDir, `${productFilename}.app`)
      : path.join(context.appOutDir, context.packager.executableName);
  await access(executablePath);

  const fuseConfig = {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === "darwin",
    strictlyRequireAllFuses: true,
  };
  for (const name of libraryFuseNames()) {
    // The trusted renderer still loads from file://. Its standard+secure custom
    // scheme migration must land before file protocol privileges can be disabled.
    fuseConfig[FuseV1Options[name]] = policy.fuses[name];
  }

  const sentinelCount = await flipFuses(executablePath, fuseConfig);
  if (sentinelCount < 1 || sentinelCount > 2) {
    throw new Error(
      `unexpected Electron fuse sentinel count ${sentinelCount}`,
    );
  }
  assertFuseWire(await getCurrentFuseWire(executablePath), policy);
}
