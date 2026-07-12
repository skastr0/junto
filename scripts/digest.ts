#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Either } from "effect";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import { digestCanvas } from "../src/shared/digest";
import type { SnapshotBundle, SnapshotState } from "../src/shared/entities";
import type { BindingHint } from "../src/shared/ipc";
import { fetchBoothBundle } from "../src/main/vellum/adapters/booth";
import { fetchQuasarBundle } from "../src/main/vellum/adapters/quasar";
import { fetchTowerBundle } from "../src/main/vellum/adapters/tower";

// Headless agent surface: `bun run digest [name]` reads
// ~/.vellum/canvases/<name>.canvas, fetches live tower/quasar/booth
// snapshots (hinted from the doc's own bindings, same as the renderer would
// pass), prints the digest to stdout, and writes the <name>.digest.txt
// sidecar. Mirrors the exportDigest IPC handler (src/main/vellum/ipc.ts)
// minus the Electron runtime — no window, no AppRuntime, adapters called
// directly since they only shell out via node:child_process.

const canvasesDir = () => join(homedir(), ".vellum", "canvases");

// Thrown for the two documented failure modes (missing/invalid canvas) and
// caught once at the bottom of this file so it prints as `digest: <msg>` and
// exits 1. Anything else propagates as an unhandled rejection — a real bug,
// not a documented exit path.
class DigestExit extends Error {}

// Same fold as SnapshotsService.refresh(): each adapter already turns its own
// CLI/parse failures into an ok:false bundle, so this only guards a truly
// unexpected throw.
const guarded = async (
  source: SnapshotBundle["source"],
  run: () => Promise<SnapshotBundle>,
): Promise<SnapshotBundle> => {
  try {
    return await run();
  } catch (error) {
    return {
      source,
      fetchedAt: new Date().toISOString(),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      entities: [],
    };
  }
};

const hintsFor = (
  hints: ReadonlyArray<BindingHint>,
  source: BindingHint["source"],
): ReadonlyArray<string> => hints.filter((hint) => hint.source === source).map((hint) => hint.key);

// Derive binding hints straight from the doc's own ether.bindings — no GUI
// state to reuse headlessly, so the digest hydrates exactly what the
// document itself points at.
const bindingHints = (doc: CanvasDoc): ReadonlyArray<BindingHint> =>
  doc.nodes.flatMap((node) =>
    (node.ether?.bindings ?? []).map((binding) => ({
      source: binding.source,
      key: binding.ref.key,
    })),
  );

const readCanvas = async (name: string, path: string): Promise<CanvasDoc> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new DigestExit(
      code === "ENOENT"
        ? `canvas "${name}" not found at ${path}`
        : `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DigestExit(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const decoded = decodeCanvasDoc(parsed);
  if (Either.isLeft(decoded)) {
    throw new DigestExit(`${path} failed validation: ${decoded.left.message}`);
  }
  return decoded.right;
};

const main = async () => {
  const name = process.argv[2]?.trim() || "portfolio";
  const path = join(canvasesDir(), `${name}.canvas`);

  const doc = await readCanvas(name, path);
  const hints = bindingHints(doc);

  const [tower, quasar, booth] = await Promise.all([
    guarded("tower", () => fetchTowerBundle()),
    guarded("quasar", () => fetchQuasarBundle(hintsFor(hints, "quasar"))),
    guarded("booth", () => fetchBoothBundle(hintsFor(hints, "booth"))),
  ]);
  const snapshots: SnapshotState = { bundles: [tower, quasar, booth] };

  const digest = digestCanvas(name, doc, snapshots);
  process.stdout.write(digest);

  const sidecarPath = join(canvasesDir(), `${name}.digest.txt`);
  await writeFile(sidecarPath, digest, "utf8");
};

try {
  await main();
} catch (error) {
  if (error instanceof DigestExit) {
    console.error(`digest: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
