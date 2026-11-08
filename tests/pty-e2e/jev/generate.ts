#!/usr/bin/env bun
/**
 * Regenerate `checkpoints.json` from the committed corpus.
 *
 *   bun tests/pty-e2e/jev/generate.ts [--fraction-steps 400] [--out <path>]
 *
 * Geometry is filled in from each capture's own manifest AFTER the walk, so a
 * capture that does not declare `pty.cols/rows` fails the run rather than
 * silently replaying at a default.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, serializeManifest, withGeometry } from "./checkpoints";
import { captureGeometry, DEFAULT_FRACTION_STEPS } from "./replay";

const here = dirname(fileURLToPath(import.meta.url));

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : fallback;
};

const fractionSteps = Number(arg("fraction-steps", String(DEFAULT_FRACTION_STEPS)));
const out = arg("out", join(here, "checkpoints.json"));

const manifest = withGeometry(
  await buildManifest({
    fractionSteps,
    onProgress: (message) => process.stderr.write(`[jev] ${message}\n`),
  }),
  captureGeometry,
);

writeFileSync(out, serializeManifest(manifest));

const byClass = manifest.checkpoints.reduce<Record<string, number>>((acc, checkpoint) => {
  acc[checkpoint.class] = (acc[checkpoint.class] ?? 0) + 1;
  return acc;
}, {});

process.stderr.write(
  `[jev] wrote ${out}: ${manifest.checkpoints.length} checkpoints over ${manifest.captures} captures ` +
    `(${Object.entries(byClass)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")})\n`,
);
