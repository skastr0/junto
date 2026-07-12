#!/usr/bin/env bun
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Either } from "effect";
import {
  applyMirrorLaw,
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
} from "../src/shared/canvas";
import { connectDoc } from "../src/shared/connect";
import { parseSignalKey } from "../src/shared/refs";
import { fetchProjectSignals } from "../src/main/vellum/adapters/tower-rest";

// Opt-in provenance edges: `bun run connect [name]` reads the canvas, draws
// `relates` edges from drilled glyph/signal nodes to their project, and from
// signal nodes to the fleet agent that emitted them. Idempotent — only adds
// edges that don't already exist. Reload the app to see them.

const canvasesDir = () => join(homedir(), ".vellum", "canvases");
const canvasPath = (name: string) => join(canvasesDir(), `${name}.canvas`);

const main = async () => {
  const name = process.argv[2] ?? "portfolio";

  let raw: string;
  try {
    raw = await readFile(canvasPath(name), "utf8");
  } catch {
    console.error(`connect: no canvas named "${name}"`);
    process.exit(1);
  }
  const decoded = decodeCanvasDoc(JSON.parse(raw));
  if (Either.isLeft(decoded)) {
    console.error(`connect: ${name}.canvas failed validation: ${decoded.left.message}`);
    process.exit(1);
  }
  const doc: CanvasDoc = decoded.right;

  // Distinct projects with signal nodes on the canvas -> fetch their signals to
  // learn each signal's source agent (not stored on the node).
  const signalProjects = new Set<string>();
  for (const node of doc.nodes) {
    for (const binding of node.ether?.bindings ?? []) {
      if (binding.source === "tower" && binding.ref.type === "signal") {
        const ref = parseSignalKey(binding.ref.key);
        if (ref) signalProjects.add(ref.project);
      }
    }
  }

  const signalAgents: Record<string, string> = {};
  await Promise.all(
    [...signalProjects].map(async (project) => {
      const result = await fetchProjectSignals(project).catch(() => ({ ok: false, signals: [] }));
      for (const signal of result.signals) {
        if (signal.sourceAgent) signalAgents[signal.signalId] = signal.sourceAgent;
      }
    }),
  );

  const before = doc.edges.length;
  const connected = connectDoc(doc, { signalAgents });
  const added = connected.edges.length - before;

  const validated = decodeCanvasDoc(connected);
  if (Either.isLeft(validated)) {
    console.error(`connect: generated doc failed validation: ${validated.left.message}`);
    process.exit(1);
  }

  const serialized = serializeCanvas(applyMirrorLaw(validated.right));
  await mkdir(canvasesDir(), { recursive: true });
  await writeFile(`${canvasPath(name)}.tmp`, serialized, "utf8");
  await rename(`${canvasPath(name)}.tmp`, canvasPath(name));

  console.error(
    `connect: added ${added} provenance edge(s) to ${name}.canvas (${connected.edges.length} total). Reload the app.`,
  );
};

void main();
