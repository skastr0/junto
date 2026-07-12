import type { CanvasDoc, CanvasNode } from "./canvas";
import { glyphKey } from "./refs";

// Glyph-level drill-down: explode a project's glyph board onto a canvas —
// one group node per orbit, one bound text node per glyph inside it. A pure
// projection like mergePortfolioInto: existing nodes/edges are preserved,
// new content is appended below whatever is already there. Idempotent by
// construction — an orbit whose group node already exists is left alone, so
// a re-run with the same (or a superset-minus-nothing) glyph list adds
// nothing new.

export interface ExplodeGlyph {
  readonly project: string;
  readonly orbit: string;
  readonly glyphId: string;
  readonly title: string;
  readonly state: string;
}

const GLYPH_W = 200;
const GLYPH_H = 46;
const GLYPH_GAP_X = 16;
const GLYPH_GAP_Y = 12;
const GLYPH_COLS = 3;
const GROUP_PAD_X = 24;
const GROUP_PAD_TOP = 50; // room for the group label
const GROUP_PAD_BOTTOM = 24;
const GROUP_GAP_X = 80;
const TITLE_MAX = 40;

const truncateTitle = (title: string): string =>
  title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 3)}...` : title;

const slug = (value: string): string =>
  value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "x";

const groupNodeId = (project: string, orbit: string): string => `grp-${slug(project)}-${slug(orbit)}`;

const glyphNodeId = (project: string, orbit: string, glyphId: string): string =>
  `gly-${slug(project)}-${slug(orbit)}-${slug(glyphId)}`;

const orbitGroupNode = (
  project: string,
  orbit: string,
  x: number,
  y: number,
  width: number,
  height: number,
): CanvasNode => ({
  id: groupNodeId(project, orbit),
  type: "group",
  label: `${project} · ${orbit}`,
  x,
  y,
  width,
  height,
});

const glyphTextNode = (glyph: ExplodeGlyph, x: number, y: number): CanvasNode => ({
  id: glyphNodeId(glyph.project, glyph.orbit, glyph.glyphId),
  type: "text",
  x,
  y,
  width: GLYPH_W,
  height: GLYPH_H,
  text: `${glyph.glyphId} ${truncateTitle(glyph.title)}`,
  ether: {
    entity: { kind: "glyph" },
    bindings: [
      {
        source: "tower",
        ref: { type: "glyph", key: glyphKey(glyph.project, glyph.orbit, glyph.glyphId) },
      },
    ],
  },
});

export const explodeProjectInto = (
  doc: CanvasDoc,
  project: string,
  glyphs: ReadonlyArray<ExplodeGlyph>,
): CanvasDoc => {
  const existingIds = new Set(doc.nodes.map((node) => node.id));

  const byOrbit = new Map<string, ExplodeGlyph[]>();
  for (const glyph of glyphs) {
    if (glyph.project !== project) continue;
    const list = byOrbit.get(glyph.orbit) ?? [];
    list.push(glyph);
    byOrbit.set(glyph.orbit, list);
  }
  const orbits = [...byOrbit.keys()].sort();

  const maxY = doc.nodes.reduce((m, node) => Math.max(m, node.y + node.height), 0);
  const originY = doc.nodes.length > 0 ? maxY + 120 : 0;

  const added: CanvasNode[] = [];
  let cursorX = 0;

  for (const orbit of orbits) {
    const groupId = groupNodeId(project, orbit);
    // Already exploded for this project/orbit — leave the existing group and
    // its glyph nodes untouched rather than risk a duplicate/colliding id.
    if (existingIds.has(groupId)) continue;

    const newGlyphs = (byOrbit.get(orbit) ?? []).filter(
      (glyph) => !existingIds.has(glyphNodeId(glyph.project, glyph.orbit, glyph.glyphId)),
    );
    if (newGlyphs.length === 0) continue;

    const cols = Math.min(GLYPH_COLS, newGlyphs.length);
    const rows = Math.ceil(newGlyphs.length / GLYPH_COLS);
    const width = GROUP_PAD_X * 2 + cols * GLYPH_W + (cols - 1) * GLYPH_GAP_X;
    const height = GROUP_PAD_TOP + GROUP_PAD_BOTTOM + rows * GLYPH_H + (rows - 1) * GLYPH_GAP_Y;

    const groupX = cursorX;
    const groupY = originY;

    existingIds.add(groupId);
    added.push(orbitGroupNode(project, orbit, groupX, groupY, width, height));

    newGlyphs.forEach((glyph, index) => {
      const col = index % GLYPH_COLS;
      const row = Math.floor(index / GLYPH_COLS);
      const node = glyphTextNode(
        glyph,
        groupX + GROUP_PAD_X + col * (GLYPH_W + GLYPH_GAP_X),
        groupY + GROUP_PAD_TOP + row * (GLYPH_H + GLYPH_GAP_Y),
      );
      existingIds.add(node.id);
      added.push(node);
    });

    cursorX += width + GROUP_GAP_X;
  }

  return { nodes: [...doc.nodes, ...added], edges: doc.edges };
};
