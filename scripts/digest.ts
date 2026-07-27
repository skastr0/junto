#!/usr/bin/env bun
import { Effect } from "effect";
import { digestCanvas } from "../src/shared/digest";
import { buildGlyphView } from "../src/shared/glyph-view";
import { readCanvasThroughControl } from "../src/main/vellum/canvas-control/client";
import { writeCanvasProjectionSidecar } from "../src/main/vellum/canvas-control/sidecars";

// The running app supplies one compiled canvas plus its current Hermes snapshot.
// This process writes only the deterministic digest sidecar.

class DigestExit extends Error {}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const main = async () => {
  const requestedName = process.argv[2] ?? "portfolio";
  const result = await Effect.runPromise(
    Effect.either(readCanvasThroughControl(requestedName)),
  );
  if (result._tag === "Left") {
    throw new DigestExit(errorMessage(result.left));
  }
  const { doc, name, snapshots } = result.right;
  const glyphs = buildGlyphView(doc, new Map());

  const digest = digestCanvas(name, doc, snapshots, glyphs);
  process.stdout.write(digest);

  await writeCanvasProjectionSidecar(name, "digest.txt", digest);
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
