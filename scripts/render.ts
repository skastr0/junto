#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { Either } from "effect";
import { decodeCanvasDoc } from "../src/shared/canvas";
import { renderCanvasSvg } from "../src/shared/svg";
import {
  canvasDocumentPathForRead,
  canvasNameFrom,
  writeCanvasSidecar,
} from "../src/main/vellum/canvases";

// Headless canvas -> SVG: the "screenshot for agents" surface. Reads
// ~/.vellum/canvases/<name>.canvas and writes <name>.svg alongside it, so a
// multimodal agent can see the board without launching the app.

const main = async () => {
  let name: string;
  let path: string;
  try {
    name = canvasNameFrom(process.argv[2] ?? "portfolio");
    path = await canvasDocumentPathForRead(name);
  } catch (error) {
    console.error(`render: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    console.error(`render: no canvas named "${name}" at ${path}`);
    process.exit(1);
  }

  const decoded = decodeCanvasDoc(JSON.parse(raw));
  if (Either.isLeft(decoded)) {
    console.error(`render: ${name}.canvas failed validation: ${decoded.left.message}`);
    process.exit(1);
  }

  const svg = renderCanvasSvg(decoded.right);
  const out = await writeCanvasSidecar(name, "svg", svg);
  console.error(
    `render: ${decoded.right.nodes.length} nodes, ${decoded.right.edges.length} edges → ${out}`,
  );
};

void main();
