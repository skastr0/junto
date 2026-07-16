import { Schema } from "effect";

// JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/) plus the namespaced
// `ether` extension. Invariant: a document stripped of every `ether` key must
// remain a valid, readable JSON Canvas 1.0 file.

export const CanvasColor = Schema.String;
export type CanvasColor = typeof CanvasColor.Type;

export const NodeSide = Schema.Literal("top", "right", "bottom", "left");
export type NodeSide = typeof NodeSide.Type;

export const EdgeEnd = Schema.Literal("none", "arrow");
export type EdgeEnd = typeof EdgeEnd.Type;

// Live edge phase — always DERIVED from criteria (+ live glyph/task state).
// Never authorial in UI: document stores criteria; evaluation produces phase;
// applyPhaseMirror may write phase back as ether.kind for offline readers.
export const EdgePhase = Schema.Literal("blocks", "depends", "relates");
export type EdgePhase = typeof EdgePhase.Type;
/** Alias used by theme/svg color maps. */
export type EtherEdgeKind = EdgePhase;
export const EtherEdgeKind = EdgePhase;

// Glyph states that count as in-flight execution work for opt-in WIP criteria.
export const WIP_GLYPH_STATES = ["committed", "building", "reviewing"] as const;
export type WipGlyphState = (typeof WIP_GLYPH_STATES)[number];

export const EtherFlag = Schema.Literal("blocker", "parked", "attention");
export type EtherFlag = typeof EtherFlag.Type;

// ref.key is always the canonical join key against Entity.key. `type` is the
// granularity a binding can point at: project (a whole project entity) or
// orbit (a per-orbit stat slice within a project).
export const TowerBinding = Schema.Struct({
  source: Schema.Literal("tower"),
  ref: Schema.Struct({
    type: Schema.Literal("project", "orbit"),
    key: Schema.String,
  }),
});
export const QuasarBinding = Schema.Struct({
  source: Schema.Literal("quasar"),
  ref: Schema.Struct({
    type: Schema.Literal("project"),
    key: Schema.String,
  }),
});
export const BoothBinding = Schema.Struct({
  source: Schema.Literal("booth"),
  ref: Schema.Struct({ type: Schema.Literal("project"), key: Schema.String }),
});
export const HermesBinding = Schema.Struct({
  source: Schema.Literal("hermes"),
  ref: Schema.Struct({ type: Schema.Literal("agent"), key: Schema.String }),
});

export const EtherBinding = Schema.Union(TowerBinding, QuasarBinding, BoothBinding, HermesBinding);
export type EtherBinding = typeof EtherBinding.Type;

// entity.kind is an open vocabulary; well-known kinds get richer rendering.
export const WELL_KNOWN_ENTITY_KINDS = [
  "project",
  "orbit",
  "plugin",
  "agent",
  "station",
  "skill",
  "task",
  "herdr",
  "page",
] as const;

// Bound herdr work surface (PTY pane on a host). Not a hermes agent binding —
// meta hydration is a service call, not the EntitySource snapshot plane.
// onDelete default is detach: removing the canvas card must not kill the pane.
export const HerdrOnDelete = Schema.Literal("detach", "kill-pane");
export type HerdrOnDelete = typeof HerdrOnDelete.Type;

export const EtherHerdr = Schema.Struct({
  host: Schema.String,
  session: Schema.optionalWith(Schema.NullOr(Schema.String), { exact: true }),
  workspaceId: Schema.optionalWith(Schema.String, { exact: true }),
  tabId: Schema.optionalWith(Schema.String, { exact: true }),
  // Required once bound; optional so partially-authored nodes can decode.
  paneId: Schema.optionalWith(Schema.String, { exact: true }),
  terminalId: Schema.optionalWith(Schema.String, { exact: true }),
  label: Schema.optionalWith(Schema.String, { exact: true }),
  onDelete: Schema.optionalWith(HerdrOnDelete, { exact: true }),
});
export type EtherHerdr = typeof EtherHerdr.Type;

/** Resolve onDelete with product default `detach` when the field is omitted. */
export const resolveHerdrOnDelete = (herdr: EtherHerdr | undefined): HerdrOnDelete =>
  herdr?.onDelete ?? "detach";

// Bound browser page work surface. Document holds profile *name* only —
// cookies live in ~/.vellum/browser (runtime), never in the .canvas file.
// Native JSON Canvas type remains `link` (url); kind "page" + ether.browser
// upgrade the node to an in-app session binding. onDelete default is detach:
// removing the card must not wipe the profile or force-kill a warm session.
export const BrowserOnDelete = Schema.Literal("detach", "kill-session");
export type BrowserOnDelete = typeof BrowserOnDelete.Type;

export const EtherBrowser = Schema.Struct({
  profile: Schema.String,
  onDelete: Schema.optionalWith(BrowserOnDelete, { exact: true }),
});
export type EtherBrowser = typeof EtherBrowser.Type;

/** Resolve onDelete with product default `detach` when the field is omitted. */
export const resolveBrowserOnDelete = (browser: EtherBrowser | undefined): BrowserOnDelete =>
  browser?.onDelete ?? "detach";

export const EtherEntity = Schema.Struct({
  kind: Schema.String,
});
export type EtherEntity = typeof EtherEntity.Type;

// A view slice: an optional per-node lens over a bound project's live data.
// Several nodes may bind the SAME project with different slices — "prism ·
// forge" in one region, "prism · beacon" in another — so a canvas can hold
// many cuts of one project. Purely presentational: it narrows what the card
// readout and the inspector browser show, never what exists.
export const EtherView = Schema.Struct({
  orbit: Schema.optionalWith(Schema.String, { exact: true }),
  // Substring or /regex/ matched against glyph id + title.
  glyphQuery: Schema.optionalWith(Schema.String, { exact: true }),
  states: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
});
export type EtherView = typeof EtherView.Type;

// Region behavior (group nodes only). `hold: true` makes the region a
// structural container: nodes spatially inside it travel with it when it
// moves. `instruction` is the region's pulse briefing: when the region
// activates (a watcher fires, a timer ticks, or a manual pulse), every agent
// node inside receives it. Membership itself is always DERIVED from geometry
// at interaction time — never stored — so the document cannot go incoherent.
// ARMING deliberately does NOT live in the document: definitions travel with
// the file; the switch that lets a pulse spend real agent turns exists only
// in the running app, flipped by a human.
export const EtherRegion = Schema.Struct({
  hold: Schema.optionalWith(Schema.Boolean, { exact: true }),
  instruction: Schema.optionalWith(Schema.String, { exact: true }),
});
export type EtherRegion = typeof EtherRegion.Type;

// A watcher is a PREDICATE node — an assertion over live source data,
// evaluated by the app's poll loop; its runtime state is derived, never
// stored. Level rules (glyphs_done, stat_threshold) describe a condition;
// the edge rule (glyphs_entered_state) fires when a watched glyph newly
// enters `state` between two evaluations.
export const WatchKind = Schema.Literal("glyphs_done", "glyphs_entered_state", "stat_threshold");
export type WatchKind = typeof WatchKind.Type;

export const EtherWatch = Schema.Struct({
  kind: WatchKind,
  // glyph rules: project+orbit scope; empty/absent glyphIds = every glyph in scope
  project: Schema.optionalWith(Schema.String, { exact: true }),
  orbit: Schema.optionalWith(Schema.String, { exact: true }),
  glyphIds: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
  state: Schema.optionalWith(Schema.String, { exact: true }), // entered-state target; default "committed"
  // stat rule: a numeric stat on a bound entity
  source: Schema.optionalWith(Schema.Literal("tower", "quasar", "booth", "hermes"), { exact: true }),
  key: Schema.optionalWith(Schema.String, { exact: true }),
  stat: Schema.optionalWith(Schema.String, { exact: true }),
  op: Schema.optionalWith(Schema.Literal("gt", "lt", "eq"), { exact: true }),
  value: Schema.optionalWith(Schema.Number, { exact: true }),
  // level watchers may mirror their unsatisfied state into the blocker flag
  flagOnUnsatisfied: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type EtherWatch = typeof EtherWatch.Type;

// A timer is a CLOCK node — a bare pulse on an interval. The definition
// lives here; whether ticks may spend agent turns is the region's in-app
// arming, never the file's.
export const EtherTimer = Schema.Struct({
  everyMinutes: Schema.Number,
});
export type EtherTimer = typeof EtherTimer.Type;

// Local checklist on a tasks node (entity.kind === "task"). State lives in the
// document; incomplete items do NOT auto-seed blocks — only an edge whose
// criteria mode is "tasks" can turn them into a generating relation.
export const EtherTaskItem = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  done: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type EtherTaskItem = typeof EtherTaskItem.Type;

export const EtherTasks = Schema.Struct({
  items: Schema.Array(EtherTaskItem),
});
export type EtherTasks = typeof EtherTasks.Type;

// Edge glyph-binding / task-binding criteria. Absence → plain relates.
// - glyphs: selected glyph ids on a project must all be "done"
// - wip:    opt-in; any glyph in committed|building|reviewing generates blocks
// - tasks:  incomplete checklist items on the fromNode (kind=task)
export const EdgeCriteriaGlyphs = Schema.Struct({
  mode: Schema.Literal("glyphs"),
  project: Schema.optionalWith(Schema.String, { exact: true }),
  orbit: Schema.optionalWith(Schema.String, { exact: true }),
  glyphIds: Schema.Array(Schema.String),
});
export type EdgeCriteriaGlyphs = typeof EdgeCriteriaGlyphs.Type;

export const EdgeCriteriaWip = Schema.Struct({
  mode: Schema.Literal("wip"),
  project: Schema.optionalWith(Schema.String, { exact: true }),
  orbit: Schema.optionalWith(Schema.String, { exact: true }),
});
export type EdgeCriteriaWip = typeof EdgeCriteriaWip.Type;

export const EdgeCriteriaTasks = Schema.Struct({
  mode: Schema.Literal("tasks"),
  // empty/absent itemIds = every item on the fromNode tasks list
  itemIds: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
});
export type EdgeCriteriaTasks = typeof EdgeCriteriaTasks.Type;

export const EdgeCriteria = Schema.Union(EdgeCriteriaGlyphs, EdgeCriteriaWip, EdgeCriteriaTasks);
export type EdgeCriteria = typeof EdgeCriteria.Type;

export const EtherNodeExtension = Schema.Struct({
  entity: Schema.optionalWith(EtherEntity, { exact: true }),
  bindings: Schema.optionalWith(Schema.Array(EtherBinding), { exact: true }),
  flags: Schema.optionalWith(Schema.Array(EtherFlag), { exact: true }),
  view: Schema.optionalWith(EtherView, { exact: true }),
  region: Schema.optionalWith(EtherRegion, { exact: true }),
  watch: Schema.optionalWith(EtherWatch, { exact: true }),
  timer: Schema.optionalWith(EtherTimer, { exact: true }),
  tasks: Schema.optionalWith(EtherTasks, { exact: true }),
  // Work-surface binding for entity.kind === "herdr". Not an EntitySource.
  herdr: Schema.optionalWith(EtherHerdr, { exact: true }),
  // Work-surface binding for entity.kind === "page" on a link node. Not an EntitySource.
  browser: Schema.optionalWith(EtherBrowser, { exact: true }),
});
export type EtherNodeExtension = typeof EtherNodeExtension.Type;

export const EtherEdgeExtension = Schema.Struct({
  // Authorial: only criteria. Absence = soft relates (never generates/relays).
  criteria: Schema.optionalWith(EdgeCriteria, { exact: true }),
  // Derived mirror of last live phase for offline JSON Canvas readers.
  // Written only by applyPhaseMirror — never set by authoring UI.
  kind: Schema.optionalWith(EdgePhase, { exact: true }),
});
export type EtherEdgeExtension = typeof EtherEdgeExtension.Type;

const nodeBase = {
  id: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  color: Schema.optionalWith(CanvasColor, { exact: true }),
  ether: Schema.optionalWith(EtherNodeExtension, { exact: true }),
};

export const TextNode = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  ...nodeBase,
});
export type TextNode = typeof TextNode.Type;

export const FileNode = Schema.Struct({
  type: Schema.Literal("file"),
  file: Schema.String,
  subpath: Schema.optionalWith(Schema.String, { exact: true }),
  ...nodeBase,
});
export type FileNode = typeof FileNode.Type;

export const LinkNode = Schema.Struct({
  type: Schema.Literal("link"),
  url: Schema.String,
  ...nodeBase,
});
export type LinkNode = typeof LinkNode.Type;

export const GroupNode = Schema.Struct({
  type: Schema.Literal("group"),
  label: Schema.optionalWith(Schema.String, { exact: true }),
  background: Schema.optionalWith(Schema.String, { exact: true }),
  backgroundStyle: Schema.optionalWith(Schema.Literal("cover", "ratio", "repeat"), {
    exact: true,
  }),
  ...nodeBase,
});
export type GroupNode = typeof GroupNode.Type;

export const CanvasNode = Schema.Union(TextNode, FileNode, LinkNode, GroupNode);
export type CanvasNode = typeof CanvasNode.Type;

export const CanvasEdge = Schema.Struct({
  id: Schema.String,
  fromNode: Schema.String,
  fromSide: Schema.optionalWith(NodeSide, { exact: true }),
  fromEnd: Schema.optionalWith(EdgeEnd, { exact: true }),
  toNode: Schema.String,
  toSide: Schema.optionalWith(NodeSide, { exact: true }),
  toEnd: Schema.optionalWith(EdgeEnd, { exact: true }),
  color: Schema.optionalWith(CanvasColor, { exact: true }),
  label: Schema.optionalWith(Schema.String, { exact: true }),
  ether: Schema.optionalWith(EtherEdgeExtension, { exact: true }),
});
export type CanvasEdge = typeof CanvasEdge.Type;

export const CanvasDoc = Schema.Struct({
  nodes: Schema.Array(CanvasNode),
  edges: Schema.Array(CanvasEdge),
});
export type CanvasDoc = typeof CanvasDoc.Type;

export const decodeCanvasDoc = Schema.decodeUnknownEither(CanvasDoc);
export const encodeCanvasDoc = Schema.encodeEither(CanvasDoc);

const NODE_KEY_ORDER = [
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "color",
  "text",
  "file",
  "subpath",
  "url",
  "label",
  "background",
  "backgroundStyle",
  "ether",
] as const;

const EDGE_KEY_ORDER = [
  "id",
  "fromNode",
  "fromSide",
  "fromEnd",
  "toNode",
  "toSide",
  "toEnd",
  "color",
  "label",
  "ether",
] as const;

const orderKeys = (value: Record<string, unknown>, order: ReadonlyArray<string>) => {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (key in value && value[key] !== undefined) out[key] = value[key];
  }
  for (const key of Object.keys(value)) {
    if (!(key in out) && value[key] !== undefined) out[key] = value[key];
  }
  return out;
};

// Canonical serialization: stable key order, node/edge array order preserved
// (array order is z-order in JSON Canvas), 2-space indent, trailing newline.
// Every writer (app, digest, tests, external agents that care) goes through this.
export const serializeCanvas = (doc: CanvasDoc): string => {
  const canonical = {
    nodes: doc.nodes.map((node) => orderKeys(node as Record<string, unknown>, NODE_KEY_ORDER)),
    edges: doc.edges.map((edge) => orderKeys(edge as Record<string, unknown>, EDGE_KEY_ORDER)),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
};

// Mirror law: extension semantics must remain visible to plain JSON Canvas
// readers. Applied on every save. Edge ether.kind is a derived phase mirror
// only (authorial truth is criteria); when present it projects to label/color.
export const applyMirrorLaw = (doc: CanvasDoc): CanvasDoc => ({
  nodes: doc.nodes.map((node) =>
    node.ether?.flags?.includes("blocker") ? { ...node, color: "1" } : node,
  ),
  edges: doc.edges.map((edge) => {
    const kind = edge.ether?.kind;
    if (kind === undefined) return edge;
    if (kind === "blocks") {
      return { ...edge, label: edge.label ?? kind, color: "1" as CanvasColor };
    }
    // Leaving blocks: drop mirror crimson "1" so demotion is visible offline.
    if (edge.color === "1") {
      const { color: _c, ...rest } = edge;
      return { ...rest, label: edge.label ?? kind };
    }
    return { ...edge, label: edge.label ?? kind };
  }),
});

// Project derived phase onto criteria edges only. Soft relates (no criteria)
// are never stamped with kind/label — free optional labels stay free.
// Blocks demotion clears mirror color "1".
export const applyPhaseMirror = (
  doc: CanvasDoc,
  phaseByEdgeId: ReadonlyMap<string, EdgePhase>,
): CanvasDoc => ({
  nodes: doc.nodes,
  edges: doc.edges.map((edge) => {
    if (!edge.ether?.criteria) return edge;
    const phase = phaseByEdgeId.get(edge.id);
    if (phase === undefined) return edge;
    const base = {
      ...edge,
      label: phase,
      ether: {
        ...edge.ether,
        kind: phase,
        criteria: edge.ether.criteria,
      },
    };
    if (phase === "blocks") return { ...base, color: "1" as CanvasColor };
    if (edge.color === "1") {
      const { color: _c, ...rest } = base;
      return rest;
    }
    return base;
  }),
});
