#!/usr/bin/env bun
import { Effect, ManagedRuntime } from "effect";
import { digestCanvas } from "../src/shared/digest";
import type { SnapshotBundle, SnapshotState } from "../src/shared/entities";
import { buildGlyphView } from "../src/shared/glyph-view";
import { HermesPlane } from "../src/main/vellum/hermes/plane";
import { HermesStandaloneLive } from "../src/main/vellum/hermes/live";
import {
  CanvasesLive,
  CanvasesService,
  canvasNameFrom,
  writeCanvasSidecar,
} from "../src/main/vellum/canvases";

// Headless agent surface: `bun run digest [name]` — hermes snapshots only.
// Canvases with tower/quasar bindings still decode; live private data is gone.
// Document bytes come from canvas-authority-v1 via CanvasesService (sole store).

const hermesRuntime = ManagedRuntime.make(HermesStandaloneLive);
const canvasesRuntime = ManagedRuntime.make(CanvasesLive);

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

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const main = async () => {
  let name: string;
  try {
    name = canvasNameFrom(process.argv[2] ?? "portfolio");
  } catch (error) {
    throw new DigestExit(errorMessage(error));
  }

  const canvases = await canvasesRuntime.runPromise(CanvasesService);
  const read = await canvasesRuntime.runPromise(Effect.either(canvases.read(name)));
  if (read._tag === "Left") {
    throw new DigestExit(errorMessage(read.left));
  }
  const doc = read.right.doc;

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
  await Promise.all([hermesRuntime.dispose(), canvasesRuntime.dispose()]);
}
