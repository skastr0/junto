#!/usr/bin/env bun
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Either } from "effect";
import { applyMirrorLaw, decodeCanvasDoc, serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { explodeProjectInto, explodeSignalsInto } from "../src/shared/explode";
import { fetchProjectGlyphs, fetchProjectSignals } from "../src/main/vellum/adapters/tower-rest";

// Headless explode: `bun run explode <project> [canvas] [--all-states] [--signals]`
// fetches the project's live glyph board (forge/beacon/scribe/survey/oracle)
// over the tower REST API and lays one group per orbit, one bound text node
// per glyph, onto ~/.vellum/canvases/<canvas|portfolio>.canvas. Existing
// nodes and the user's arrangement are preserved; only newly-seen glyphs are
// appended. Reload the app to see them; state/title hydrate live via
// resolveTowerGlyphHints on refresh.
//
// --signals additionally explodes the project's signal feed alongside the
// glyph board (one group per orbit, one bound text node per signal),
// hydrated live via resolveTowerSignalHints on refresh.

const canvasesDir = () => join(homedir(), ".vellum", "canvases");
const canvasPath = (name: string) => join(canvasesDir(), `${name}.canvas`);

const readExisting = async (name: string): Promise<CanvasDoc> => {
  try {
    const raw = await readFile(canvasPath(name), "utf8");
    const decoded = decodeCanvasDoc(JSON.parse(raw));
    if (Either.isRight(decoded)) return decoded.right;
    console.error(`explode: ${name}.canvas is invalid, starting fresh`);
  } catch {
    // no existing canvas — start empty
  }
  return { nodes: [], edges: [] };
};

const orbitSummaryOf = <T extends { orbit: string }>(items: ReadonlyArray<T>): string => {
  const byOrbit = new Map<string, number>();
  for (const item of items) byOrbit.set(item.orbit, (byOrbit.get(item.orbit) ?? 0) + 1);
  return [...byOrbit.entries()].map(([orbit, count]) => `${orbit}:${count}`).join(" ");
};

const main = async () => {
  const args = process.argv.slice(2);
  const allStates = args.includes("--all-states");
  const withSignals = args.includes("--signals");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const project = positional[0];
  const canvasName = positional[1] ?? "portfolio";

  if (!project) {
    console.error("usage: bun run explode <project> [canvas] [--all-states] [--signals]");
    process.exit(1);
  }

  const glyphResult = await fetchProjectGlyphs(project, { activeOnly: !allStates });
  if (!glyphResult.ok) {
    console.error(`explode: failed to fetch glyphs for "${project}": ${glyphResult.error ?? "unknown error"}`);
    process.exit(1);
  }

  const signalResult = withSignals ? await fetchProjectSignals(project) : undefined;
  if (withSignals && !signalResult?.ok) {
    console.error(`explode: failed to fetch signals for "${project}": ${signalResult?.error ?? "unknown error"}`);
    process.exit(1);
  }

  if (glyphResult.glyphs.length === 0 && (signalResult?.signals.length ?? 0) === 0) {
    console.error(
      `explode: project "${project}" has no ${allStates ? "" : "active "}glyphs${withSignals ? " or signals" : ""} on the board`,
    );
    process.exit(1);
  }

  const existing = await readExisting(canvasName);
  let exploded = explodeProjectInto(existing, project, glyphResult.glyphs);
  if (signalResult) exploded = explodeSignalsInto(exploded, project, signalResult.signals);
  const added = exploded.nodes.length - existing.nodes.length;

  const validated = decodeCanvasDoc(exploded);
  if (Either.isLeft(validated)) {
    console.error(`explode: generated doc failed validation: ${validated.left.message}`);
    process.exit(1);
  }

  const serialized = serializeCanvas(applyMirrorLaw(validated.right));
  await mkdir(canvasesDir(), { recursive: true });
  const path = canvasPath(canvasName);
  await writeFile(`${path}.tmp`, serialized, "utf8");
  await rename(`${path}.tmp`, path);

  const parts = [
    `${glyphResult.glyphs.length} ${allStates ? "" : "active "}glyph(s) fetched (${orbitSummaryOf(glyphResult.glyphs)})`,
  ];
  if (signalResult) parts.push(`${signalResult.signals.length} signal(s) fetched (${orbitSummaryOf(signalResult.signals)})`);

  console.error(
    `explode: ${project} → ${parts.join(", ")}, added ${added} new node(s) to ${canvasName}.canvas (${exploded.nodes.length} total). Reload the app.`,
  );
};

void main();
