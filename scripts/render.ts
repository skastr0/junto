#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Either } from "effect";
import { decodeCanvasDoc } from "../src/shared/canvas";
import { renderCanvasSvg } from "../src/shared/svg";

// Headless canvas -> SVG: the "screenshot for agents" surface. Reads
// ~/.vellum/canvases/<name>.canvas and writes <name>.svg alongside it, so a
// multimodal agent can see the board without launching the app.

const canvasesDir = () => join(homedir(), ".vellum", "canvases");

const main = async () => {
  const name = process.argv[2] ?? "portfolio";
  const path = join(canvasesDir(), `${name}.canvas`);

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
  const out = join(canvasesDir(), `${name}.svg`);
  await writeFile(out, svg, "utf8");
  console.error(
    `render: ${decoded.right.nodes.length} nodes, ${decoded.right.edges.length} edges → ${out}`,
  );
};

void main();
