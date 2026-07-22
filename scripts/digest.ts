#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { Either, ManagedRuntime } from "effect";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import { digestCanvas } from "../src/shared/digest";
import type { SnapshotBundle, SnapshotState } from "../src/shared/entities";
import { buildGlyphView } from "../src/shared/glyph-view";
import { HermesPlane } from "../src/main/vellum/hermes/plane";
import { HermesStandaloneLive } from "../src/main/vellum/hermes/live";
import {
  canvasDocumentPathForRead,
  canvasNameFrom,
  writeCanvasSidecar,
} from "../src/main/vellum/canvases";

// Headless agent surface: `bun run digest [name]` — hermes snapshots only.
// Canvases with tower/quasar bindings still decode; live private data is gone.

const hermesRuntime = ManagedRuntime.make(HermesStandaloneLive);

class DigestExit extends Error {}

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
  let name: string;
  let path: string;
  try {
    name = canvasNameFrom(process.argv[2] ?? "portfolio");
    path = await canvasDocumentPathForRead(name);
  } catch (error) {
    throw new DigestExit(error instanceof Error ? error.message : String(error));
  }

  const doc = await readCanvas(name, path);
  const hermesPlane = await hermesRuntime.runPromise(HermesPlane);

  const hermes = await guarded("hermes", hermesPlane.fetchBundle);
  const snapshots: SnapshotState = { bundles: [hermes] };
  const glyphs = buildGlyphView(doc, new Map());

  const digest = digestCanvas(name, doc, snapshots, glyphs);
  process.stdout.write(digest);

  await writeCanvasSidecar(name, "digest.txt", digest);
};

try {
  await main();
} catch (error) {
  if (error instanceof DigestExit) {
    console.error(`digest: ${error.message}`);
    process.exit(1);
  }
  throw error;
} finally {
  await hermesRuntime.dispose();
}
