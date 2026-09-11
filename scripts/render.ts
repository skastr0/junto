#!/usr/bin/env bun
import { Effect } from "effect";
import { executionGraphContextFromActorRefs } from "../src/shared/graph";
import { renderCanvasSvg } from "../src/shared/svg";
import { readCanvasThroughControl } from "../src/main/vellum-command/canvas-control/client";
import { writeCanvasProjectionSidecar } from "../src/main/vellum-command/canvas-control/sidecars";

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
  // Usage: bun run render [name] [--mode dark|bright]
  const args = process.argv.slice(2);
  const modeFlag = args.indexOf("--mode");
  const mode =
    modeFlag >= 0 && args[modeFlag + 1] === "bright" ? "bright" : "dark";
  const name = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--mode") ?? "portfolio";
  const read = await Effect.runPromise(
    Effect.result(readCanvasThroughControl(name)),
  );
  if (read._tag === "Failure") {
    console.error(`render: ${errorMessage(read.failure)}`);
    process.exitCode = 1;
    return;
  }

  const { actorRefs, doc, name: canvasName } = read.success;
  const svg = renderCanvasSvg(
    doc,
    executionGraphContextFromActorRefs(canvasName, actorRefs),
    mode,
  );
  const out = await writeCanvasProjectionSidecar(canvasName, "svg", svg);
  console.error(`render: ${doc.nodes.length} nodes, ${doc.edges.length} edges (${mode}) → ${out}`);
};

await main();
