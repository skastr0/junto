/**
 * Read the committed checkpoint manifest.
 *
 * Kept separate from `checkpoints.ts` so the live entry point does not drag the
 * generator's replay machinery into its import graph: a paid run reads the
 * manifest and replays only the captures it actually needs.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckpointManifest } from "./types";

export const manifestPath = (): string => join(dirname(fileURLToPath(import.meta.url)), "checkpoints.json");

export const loadManifest = (path = manifestPath()): CheckpointManifest => {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as CheckpointManifest;
  if (parsed.version !== 1) {
    throw new Error(`unsupported checkpoint manifest version ${String(parsed.version)} at ${path}`);
  }
  return parsed;
};
