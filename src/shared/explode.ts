import type { CanvasDoc, CanvasNode } from "./canvas";
import { glyphKey, sessionKey, signalKey } from "./refs";

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

// Signal-level drill-down: same shape as explodeProjectInto above, against
// a project's signal feed instead of its glyph board. One group node per
// orbit ("<project> · <orbit> signals"), one bound text node per signal.
// Same idempotency guarantee: an orbit whose group node already exists is
// left alone.

export interface ExplodeSignal {
  readonly project: string;
  readonly orbit: string;
  readonly signalId: string;
  readonly status: string;
  readonly kind: string;
  readonly summary: string;
  readonly sourceAgent?: string;
}

const SIGNAL_W = 220;
const SIGNAL_H = 46;
const SIGNAL_GAP_X = 16;
const SIGNAL_GAP_Y = 12;
const SIGNAL_COLS = 3;
const SIGNAL_GROUP_PAD_X = 24;
const SIGNAL_GROUP_PAD_TOP = 50; // room for the group label
const SIGNAL_GROUP_PAD_BOTTOM = 24;
const SIGNAL_GROUP_GAP_X = 80;
const SIGNAL_SUMMARY_MAX = 36;

const truncateSummary = (summary: string): string =>
  summary.length > SIGNAL_SUMMARY_MAX ? `${summary.slice(0, SIGNAL_SUMMARY_MAX - 3)}...` : summary;

// "prism.workflow_runtime.architecture_requested" -> "architecture_requested";
// "exploration" (no namespace) -> "exploration" unchanged.
const kindShort = (kind: string): string =>
  kind.includes(".") ? kind.slice(kind.lastIndexOf(".") + 1) : kind;

const signalGroupNodeId = (project: string, orbit: string): string =>
  `sig-grp-${slug(project)}-${slug(orbit)}`;

const signalNodeId = (project: string, orbit: string, signalId: string): string =>
  `sig-${slug(project)}-${slug(orbit)}-${slug(signalId)}`;

const signalGroupNode = (
  project: string,
  orbit: string,
  x: number,
  y: number,
  width: number,
  height: number,
): CanvasNode => ({
  id: signalGroupNodeId(project, orbit),
  type: "group",
  label: `${project} · ${orbit} signals`,
  x,
  y,
  width,
  height,
});

const signalTextNode = (signal: ExplodeSignal, x: number, y: number): CanvasNode => ({
  id: signalNodeId(signal.project, signal.orbit, signal.signalId),
  type: "text",
  x,
  y,
  width: SIGNAL_W,
  height: SIGNAL_H,
  text: `${kindShort(signal.kind)} · ${truncateSummary(signal.summary)}`,
  ether: {
    entity: { kind: "signal" },
    bindings: [
      {
        source: "tower",
        ref: { type: "signal", key: signalKey(signal.project, signal.orbit, signal.signalId) },
      },
    ],
  },
});

export const explodeSignalsInto = (
  doc: CanvasDoc,
  project: string,
  signals: ReadonlyArray<ExplodeSignal>,
): CanvasDoc => {
  const existingIds = new Set(doc.nodes.map((node) => node.id));

  const byOrbit = new Map<string, ExplodeSignal[]>();
  for (const signal of signals) {
    if (signal.project !== project) continue;
    const list = byOrbit.get(signal.orbit) ?? [];
    list.push(signal);
    byOrbit.set(signal.orbit, list);
  }
  const orbits = [...byOrbit.keys()].sort();

  const maxY = doc.nodes.reduce((m, node) => Math.max(m, node.y + node.height), 0);
  const originY = doc.nodes.length > 0 ? maxY + 120 : 0;

  const added: CanvasNode[] = [];
  let cursorX = 0;

  for (const orbit of orbits) {
    const groupId = signalGroupNodeId(project, orbit);
    // Already exploded for this project/orbit — leave the existing group and
    // its signal nodes untouched rather than risk a duplicate/colliding id.
    if (existingIds.has(groupId)) continue;

    const newSignals = (byOrbit.get(orbit) ?? []).filter(
      (signal) => !existingIds.has(signalNodeId(signal.project, signal.orbit, signal.signalId)),
    );
    if (newSignals.length === 0) continue;

    const cols = Math.min(SIGNAL_COLS, newSignals.length);
    const rows = Math.ceil(newSignals.length / SIGNAL_COLS);
    const width = SIGNAL_GROUP_PAD_X * 2 + cols * SIGNAL_W + (cols - 1) * SIGNAL_GAP_X;
    const height =
      SIGNAL_GROUP_PAD_TOP + SIGNAL_GROUP_PAD_BOTTOM + rows * SIGNAL_H + (rows - 1) * SIGNAL_GAP_Y;

    const groupX = cursorX;
    const groupY = originY;

    existingIds.add(groupId);
    added.push(signalGroupNode(project, orbit, groupX, groupY, width, height));

    newSignals.forEach((signal, index) => {
      const col = index % SIGNAL_COLS;
      const row = Math.floor(index / SIGNAL_COLS);
      const node = signalTextNode(
        signal,
        groupX + SIGNAL_GROUP_PAD_X + col * (SIGNAL_W + SIGNAL_GAP_X),
        groupY + SIGNAL_GROUP_PAD_TOP + row * (SIGNAL_H + SIGNAL_GAP_Y),
      );
      existingIds.add(node.id);
      added.push(node);
    });

    cursorX += width + SIGNAL_GROUP_GAP_X;
  }

  return { nodes: [...doc.nodes, ...added], edges: doc.edges };
};

// Session-level drill-down: same shape as explodeSignalsInto above, against
// a project's quasar session history instead of its tower signal feed. One
// difference in layout: quasar sessions carry no orbit dimension, so this is
// a single group per project ("<project> · sessions") rather than one group
// per orbit. Same idempotency guarantee: once that group node exists, a
// re-run leaves it (and its session nodes) untouched rather than risk a
// duplicate/colliding id.

export interface ExplodeSession {
  readonly sessionId: string;
  readonly provider: string;
  readonly title?: string;
  readonly messageCount: number;
}

const SESSION_W = 220;
const SESSION_H = 46;
const SESSION_GAP_X = 16;
const SESSION_GAP_Y = 12;
const SESSION_COLS = 3;
const SESSION_GROUP_PAD_X = 24;
const SESSION_GROUP_PAD_TOP = 50; // room for the group label
const SESSION_GROUP_PAD_BOTTOM = 24;
const SESSION_TEXT_MAX = 36;

const truncateSessionText = (text: string): string =>
  text.length > SESSION_TEXT_MAX ? `${text.slice(0, SESSION_TEXT_MAX - 3)}...` : text;

const sessionGroupNodeId = (project: string): string => `ses-grp-${slug(project)}`;

const sessionNodeId = (sessionId: string): string => `ses-${slug(sessionId)}`;

const sessionGroupNode = (
  project: string,
  x: number,
  y: number,
  width: number,
  height: number,
): CanvasNode => ({
  id: sessionGroupNodeId(project),
  type: "group",
  label: `${project} · sessions`,
  x,
  y,
  width,
  height,
});

const sessionTextNode = (session: ExplodeSession, x: number, y: number): CanvasNode => ({
  id: sessionNodeId(session.sessionId),
  type: "text",
  x,
  y,
  width: SESSION_W,
  height: SESSION_H,
  text: truncateSessionText(`${session.provider} · ${session.title || `${session.messageCount} msgs`}`),
  ether: {
    entity: { kind: "session" },
    bindings: [{ source: "quasar", ref: { type: "session", key: sessionKey(session.sessionId) } }],
  },
});

export const explodeSessionsInto = (
  doc: CanvasDoc,
  project: string,
  sessions: ReadonlyArray<ExplodeSession>,
): CanvasDoc => {
  const existingIds = new Set(doc.nodes.map((node) => node.id));

  const groupId = sessionGroupNodeId(project);
  // Already exploded for this project — leave the existing group and its
  // session nodes untouched rather than risk a duplicate/colliding id.
  if (existingIds.has(groupId)) return doc;

  const newSessions = sessions.filter((session) => !existingIds.has(sessionNodeId(session.sessionId)));
  if (newSessions.length === 0) return doc;

  const maxY = doc.nodes.reduce((m, node) => Math.max(m, node.y + node.height), 0);
  const originY = doc.nodes.length > 0 ? maxY + 120 : 0;

  const cols = Math.min(SESSION_COLS, newSessions.length);
  const rows = Math.ceil(newSessions.length / SESSION_COLS);
  const width = SESSION_GROUP_PAD_X * 2 + cols * SESSION_W + (cols - 1) * SESSION_GAP_X;
  const height =
    SESSION_GROUP_PAD_TOP + SESSION_GROUP_PAD_BOTTOM + rows * SESSION_H + (rows - 1) * SESSION_GAP_Y;

  const added: CanvasNode[] = [sessionGroupNode(project, 0, originY, width, height)];

  newSessions.forEach((session, index) => {
    const col = index % SESSION_COLS;
    const row = Math.floor(index / SESSION_COLS);
    added.push(
      sessionTextNode(
        session,
        SESSION_GROUP_PAD_X + col * (SESSION_W + SESSION_GAP_X),
        originY + SESSION_GROUP_PAD_TOP + row * (SESSION_H + SESSION_GAP_Y),
      ),
    );
  });

  return { nodes: [...doc.nodes, ...added], edges: doc.edges };
};
