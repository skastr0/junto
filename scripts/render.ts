#!/usr/bin/env bun
import { Effect, ManagedRuntime } from "effect";
import { renderCanvasSvg } from "../src/shared/svg";
import {
  CanvasesLive,
  CanvasesService,
  canvasNameFrom,
  writeCanvasSidecar,
} from "../src/main/vellum/canvases";

// Headless canvas -> SVG: the "screenshot for agents" surface. Reads the
// named canvas from canvas-authority-v1 via CanvasesService and writes
// <name>.svg as a sidecar so a multimodal agent can see the board without
// launching the app.

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const main = async () => {
  const runtime = ManagedRuntime.make(CanvasesLive);
  try {
    let name: string;
    try {
      name = canvasNameFrom(process.argv[2] ?? "portfolio");
    } catch (error) {
      console.error(`render: ${errorMessage(error)}`);
      process.exitCode = 1;
      return;
    }

    const canvases = await runtime.runPromise(CanvasesService);
    const read = await runtime.runPromise(Effect.either(canvases.read(name)));
    if (read._tag === "Left") {
      console.error(`render: ${errorMessage(read.left)}`);
      process.exit(1);
    }

    const doc = read.right.doc;
    const svg = renderCanvasSvg(doc);
    const out = await writeCanvasSidecar(name, "svg", svg);
    console.error(`render: ${doc.nodes.length} nodes, ${doc.edges.length} edges → ${out}`);
  } finally {
    await runtime.dispose();
  }
};

void main();
