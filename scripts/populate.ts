#!/usr/bin/env bun
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Either } from "effect";
import {
  applyMirrorLaw,
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
} from "../src/shared/canvas";
import type { BindingHint } from "../src/shared/ipc";
import type { SnapshotBundle, SnapshotState } from "../src/shared/entities";
import { mergePortfolioInto, mergeProjects } from "../src/shared/portfolio";
import { fetchBoothBundle } from "../src/main/vellum/adapters/booth";
import { fetchHermesBundle } from "../src/main/vellum/adapters/hermes";
import { fetchQuasarBundle } from "../src/main/vellum/adapters/quasar";
import { fetchTowerBundle } from "../src/main/vellum/adapters/tower";

// Headless populate: `bun run populate [name]` fetches the live tower/quasar/
// booth corpus and merges one bound project node per real project onto
// ~/.vellum/canvases/<name>.canvas (default "portfolio"). A regenerable
// projection of the real corpus — existing nodes and the user's arrangement
// are preserved; only newly-seen projects are appended. Reload the app to see
// them; stats hydrate live.

const canvasesDir = () => join(homedir(), ".vellum", "canvases");
const canvasPath = (name: string) => join(canvasesDir(), `${name}.canvas`);

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

const readExisting = async (name: string): Promise<CanvasDoc> => {
  try {
    const raw = await readFile(canvasPath(name), "utf8");
    const decoded = decodeCanvasDoc(JSON.parse(raw));
    if (Either.isRight(decoded)) return decoded.right;
    console.error(`populate: ${name}.canvas is invalid, starting fresh`);
  } catch {
    // no existing canvas — start empty
  }
  return { nodes: [], edges: [] };
};

const main = async () => {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const name = args.find((a) => !a.startsWith("--")) ?? "portfolio";

  // Full corpus: no hints needed — we want every project, not per-key detail.
  const hints: ReadonlyArray<BindingHint> = [];
  const [tower, quasar, booth, hermes] = await Promise.all([
    guarded("tower", () => fetchTowerBundle()),
    guarded("quasar", () => fetchQuasarBundle(hints.map((h) => h.key))),
    guarded("booth", () => fetchBoothBundle(hints.map((h) => h.key))),
    guarded("hermes", () => fetchHermesBundle()),
  ]);
  const state: SnapshotState = { bundles: [tower, quasar, booth, hermes] };

  for (const bundle of state.bundles) {
    console.error(
      `  ${bundle.source} :: ${bundle.ok ? `${bundle.entities.length} entities` : `down (${bundle.error})`}`,
    );
  }

  const existing = await readExisting(name);
  const merged = mergePortfolioInto(existing, state, { all });
  const added = merged.nodes.length - existing.nodes.length;

  const validated = decodeCanvasDoc(merged);
  if (Either.isLeft(validated)) {
    console.error(`populate: generated doc failed validation: ${validated.left.message}`);
    process.exit(1);
  }

  const serialized = serializeCanvas(applyMirrorLaw(validated.right));
  await mkdir(canvasesDir(), { recursive: true });
  const path = canvasPath(name);
  // Unique per write so a populate run racing the live app (both writing
  // the same canvas — see AGENTS.md's headless-populate-while-app-runs
  // workflow) never shares a tmp file with the app's own writer.
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, serialized, "utf8");
  await rename(tmpPath, path);

  const totalProjects = mergeProjects(state, { all }).length;
  console.error(
    `populate: ${totalProjects} ${all ? "" : "owned "}projects → added ${added} new node(s) to ${name}.canvas (${merged.nodes.length} total). ${all ? "" : "Use --all for every indexed repo. "}Reload the app.`,
  );
};

void main();
