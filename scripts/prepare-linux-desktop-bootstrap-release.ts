#!/usr/bin/env bun
/** Assemble attested Linux desktop bootstrap bytes beside the compiled binary. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LINUX_DESKTOP_BOOTSTRAP_VERSION } from "../src/main/junto/update/linux-first-install";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LINUX_DESKTOP_BOOTSTRAP_NAME =
  "junto-desktop-bootstrap-linux-x64";

export const linuxDesktopBootstrapReleaseAssets = (): readonly string[] => [
  LINUX_DESKTOP_BOOTSTRAP_NAME,
  `${LINUX_DESKTOP_BOOTSTRAP_NAME}.sha256`,
  `${LINUX_DESKTOP_BOOTSTRAP_NAME}.attestation.jsonl`,
];

const digestFile = (path: string): { readonly bytes: number; readonly sha256: string } => {
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};

export const prepareLinuxDesktopBootstrapRelease = (input: {
  readonly distDirectory?: string;
}): {
  readonly assets: readonly string[];
  readonly sha256: string;
} => {
  const dist = resolve(input.distDirectory ?? resolve(root, "dist"));
  mkdirSync(dist, { recursive: true });
  const binary = resolve(dist, LINUX_DESKTOP_BOOTSTRAP_NAME);
  const actualBinary = digestFile(binary);
  writeFileSync(
    `${binary}.sha256`,
    `${actualBinary.sha256}  ${LINUX_DESKTOP_BOOTSTRAP_NAME}\n`,
  );
  return { assets: linuxDesktopBootstrapReleaseAssets(), sha256: actualBinary.sha256 };
};

if (import.meta.main) {
  const prepared = prepareLinuxDesktopBootstrapRelease({});
  process.stdout.write(`${JSON.stringify({
    bootstrapVersion: LINUX_DESKTOP_BOOTSTRAP_VERSION,
    assets: prepared.assets,
    sha256: prepared.sha256,
  })}\n`);
}
