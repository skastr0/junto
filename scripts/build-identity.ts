import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveBuildFeatures } from "./build-features";

/** Shared by the window and the machine bundle. Paths are relative and sorted. */
export const buildIdentity = (
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const hash = createHash("sha256");
  const files = ["package.json", "bun.lock", "tsconfig.json", "electron.vite.config.ts", "scripts/build-identity.ts", "scripts/build-machine.ts", "scripts/build-features.ts", "scripts/build-standalone-cli.ts", "scripts/unix-peer-pid.py"];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(relative(root, file).split("\\").join("/"));
      else throw new Error(`build source must be a regular file: ${file}`);
    }
  };
  walk(join(root, "src"));
  hash.update(resolveBuildFeatures(env).fingerprint);
  for (const file of files.sort()) {
    const bytes = readFileSync(join(root, file));
    hash.update(`\0${file}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
};
