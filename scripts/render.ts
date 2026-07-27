#!/usr/bin/env bun
import { Effect } from "effect";
import { renderCanvasSvg } from "../src/shared/svg";
import { readCanvasThroughControl } from "../src/main/vellum/canvas-control/client";
import { writeCanvasProjectionSidecar } from "../src/main/vellum/canvas-control/sidecars";

// Headless canvas -> SVG. The running app supplies the compiled live canvas;
// this process writes only the agent-facing SVG sidecar.

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
};

const main = async () => {
  const read = await Effect.runPromise(
    Effect.either(
      readCanvasThroughControl(process.argv[2] ?? "portfolio"),
    ),
  );
  if (read._tag === "Left") {
    console.error(`render: ${errorMessage(read.left)}`);
    process.exitCode = 1;
    return;
  }

  const { doc, name } = read.right;
  const svg = renderCanvasSvg(doc);
  const out = await writeCanvasProjectionSidecar(name, "svg", svg);
  console.error(`render: ${doc.nodes.length} nodes, ${doc.edges.length} edges → ${out}`);
};

await main();
