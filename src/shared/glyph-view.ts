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
  for (const project of edgeGlyphProjects(doc)) {
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

export const projectsNeedingGlyphs = (doc: CanvasDoc): ReadonlyArray<string> =>
  Array.from(edgeGlyphProjects(doc));
