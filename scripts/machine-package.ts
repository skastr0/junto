import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMachineBundle } from "../src/main/junto/hosts/bundle";
import { buildIdentity } from "./build-identity";
import { resolveBuildFeatures } from "./build-features";

export const MACHINE_PACKAGE_TARGETS = ["darwin-arm64", "linux-x64"] as const;

export interface MachinePackageExpectation {
  readonly build?: string;
  readonly appVersion?: string;
  readonly required?: boolean;
}

/** A delivery package is one complete cohort, never a mix of native builds. */
export const checkMachinePackage = async (
  directory: string,
  expected: MachinePackageExpectation = {},
) => {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("machine payload root must be a directory");
  const targets = (await readdir(directory)).sort();
  if (JSON.stringify(targets) !== JSON.stringify(MACHINE_PACKAGE_TARGETS)) throw new Error("machine package must contain exactly darwin-arm64 and linux-x64");
  const manifests = [];
  for (const target of MACHINE_PACKAGE_TARGETS) {
    const manifest = await inspectMachineBundle(join(directory, target));
    if (manifest.target !== target) throw new Error("machine payload target does not match its directory");
    if (expected.build !== undefined && manifest.build !== expected.build) throw new Error("machine payload build does not match the desktop build");
    if (expected.appVersion !== undefined && manifest.appVersion !== expected.appVersion) throw new Error("machine payload version does not match the desktop version");
    manifests.push(manifest);
  }
  if (manifests[0]!.build !== manifests[1]!.build || manifests[0]!.appVersion !== manifests[1]!.appVersion) throw new Error("machine payloads must share one build and version");
  return manifests;
};

export const sourceMachinePackage = async (): Promise<MachinePackageExpectation> => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
  return { build: buildIdentity(root), appVersion: version, required: resolveBuildFeatures().features.fleetUi !== false };
};

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) throw new Error("usage: bun scripts/machine-package.ts DIRECTORY");
  const expected = await sourceMachinePackage();
  await checkMachinePackage(directory, expected);
  process.stdout.write(`${JSON.stringify({ ok: true, ...expected, targets: MACHINE_PACKAGE_TARGETS })}\n`);
}
