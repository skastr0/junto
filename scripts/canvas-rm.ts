#!/usr/bin/env bun
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Headless agent surface: `bun run canvas:rm <name> [name...]` deletes canvas
// documents under ~/.vellum/canvases. Removes known derived sidecars
// (digest.txt, svg) when present. Exits non-zero if any named canvas is
// missing or the name is invalid. `--json` emits a machine-readable report.

const NAME_PATTERN = /^[a-z0-9-]+$/;
const SIDECAR_SUFFIXES = ["digest.txt", "svg"] as const;

const canvasesDir = () =>
  process.env.VELLUM_CANVASES_DIR || join(homedir(), ".vellum", "canvases");

interface DeleteResult {
  readonly name: string;
  readonly ok: boolean;
  readonly path?: string;
  readonly removedSidecars?: ReadonlyArray<string>;
  readonly error?: string;
}

const sanitizeName = (raw: string): string | { error: string } => {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0 || !NAME_PATTERN.test(normalized)) {
    return {
      error: `invalid canvas name "${raw}": use lowercase letters, numbers, and hyphens only`,
    };
  }
  return normalized;
};

const removeOne = async (raw: string): Promise<DeleteResult> => {
  const sanitized = sanitizeName(raw);
  if (typeof sanitized === "object") {
    return { name: raw, ok: false, error: sanitized.error };
  }

  const path = join(canvasesDir(), `${sanitized}.canvas`);
  try {
    await stat(path);
  } catch {
    return { name: sanitized, ok: false, path, error: `canvas "${sanitized}" does not exist` };
  }

  await rm(path);

  const removedSidecars: string[] = [];
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecar = join(canvasesDir(), `${sanitized}.${suffix}`);
    try {
      await rm(sidecar);
      removedSidecars.push(`${sanitized}.${suffix}`);
    } catch {
      // optional
    }
  }

  return {
    name: sanitized,
    ok: true,
    path,
    ...(removedSidecars.length > 0 ? { removedSidecars } : {}),
  };
};

const usage = (): never => {
  console.error("usage: bun run canvas:rm <name> [name...] [--json]");
  console.error("  deletes canvas document(s) under ~/.vellum/canvases");
  process.exit(2);
};

const main = async () => {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const names = args.filter((arg) => arg !== "--json");

  if (names.length === 0) usage();

  await mkdir(canvasesDir(), { recursive: true });

  // Refuse deleting names that only exist as non-canvas files in the dir —
  // list is not required, but a friendly hint when the operator mistypes.
  const results = await Promise.all(names.map(removeOne));

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      if (result.ok) {
        const extras =
          result.removedSidecars && result.removedSidecars.length > 0
            ? ` (+ ${result.removedSidecars.join(", ")})`
            : "";
        console.log(`deleted ${result.name}${extras}`);
      } else {
        console.error(`failed ${result.name}: ${result.error}`);
      }
    }

    const remaining = (await readdir(canvasesDir())).filter((file) => file.endsWith(".canvas"));
    if (remaining.length === 0) {
      console.log(`no canvases left in ${canvasesDir()}`);
    }
  }

  if (results.some((result) => !result.ok)) process.exit(1);
};

await main();
