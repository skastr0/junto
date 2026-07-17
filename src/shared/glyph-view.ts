import type { CanvasDoc } from "./canvas";
import { edgeGlyphProjects, type GlyphRow, type GlyphView } from "./execution-graph";

// Build a GlyphView for digest/export paths. Pure over the fetch results so
// unit tests can supply rows without tower. Partial/failed project reads are
// omitted (missing key → criteria stay non-generating / relates).

export type GlyphFetchResult = {
  readonly ok: boolean;
  readonly partial?: boolean;
  readonly glyphs: ReadonlyArray<{
    readonly glyphId: string;
    readonly orbit: string;
    readonly title: string;
    readonly state: string;
  }>;
};

export const buildGlyphView = (
  doc: CanvasDoc,
  fetched: ReadonlyMap<string, GlyphFetchResult>,
): GlyphView => {
  const view = new Map<string, ReadonlyArray<GlyphRow> | undefined>();
  // Union of edge-criteria projects and every project entity on the canvas.
  for (const project of canvasProjectKeys(doc)) {
    const result = fetched.get(project);
    if (!result || !result.ok || result.partial) continue;
    view.set(
      project,
      result.glyphs.map((row) => ({
        glyphId: row.glyphId,
        orbit: row.orbit,
        title: row.title,
        state: row.state,
      })),
    );
  }
  return view;
};

/** Projects referenced by edge criteria (execution-graph WIP/blocks). */
export const projectsNeedingGlyphs = (doc: CanvasDoc): ReadonlyArray<string> =>
  Array.from(edgeGlyphProjects(doc));

/**
 * Every project entity on the canvas plus edge-criteria projects.
 * Region rollups and digest use this so project WIP shows even when the
 * canvas has no edges (criteria-only collection would return empty).
 */
export const canvasProjectKeys = (doc: CanvasDoc): ReadonlyArray<string> => {
  const keys = new Set<string>(edgeGlyphProjects(doc));
  for (const node of doc.nodes) {
    const entity = node.ether?.entity;
    if (entity?.kind === "project" && entity.name !== undefined && entity.name.length > 0) {
      keys.add(entity.name);
    }
  }
  return Array.from(keys);
};
