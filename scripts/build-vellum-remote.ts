/**
 * Build the displayless Node Remote with the canonical Linux package recipe.
 * The package path adds source/schema provenance after this bundle is written.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRemoteEntryBundle } from "./build-linux-remote-runtime";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const receipt = await buildRemoteEntryBundle({ repoRoot });
process.stdout.write(
  `remote:build → ${receipt.entryPath} (${String(receipt.bytes)} bytes)\n`,
);
