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

export const EtherEdgeKind = Schema.Literal("blocks", "depends", "relates");
export type EtherEdgeKind = typeof EtherEdgeKind.Type;

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
] as const;

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
// moves. Membership itself is always DERIVED from geometry at interaction
// time — never stored — so the document cannot go incoherent.
export const EtherRegion = Schema.Struct({
  hold: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type EtherRegion = typeof EtherRegion.Type;

export const EtherNodeExtension = Schema.Struct({
  entity: Schema.optionalWith(EtherEntity, { exact: true }),
  bindings: Schema.optionalWith(Schema.Array(EtherBinding), { exact: true }),
  flags: Schema.optionalWith(Schema.Array(EtherFlag), { exact: true }),
  view: Schema.optionalWith(EtherView, { exact: true }),
  region: Schema.optionalWith(EtherRegion, { exact: true }),
});
export type EtherNodeExtension = typeof EtherNodeExtension.Type;

export const EtherEdgeExtension = Schema.Struct({
  kind: Schema.optionalWith(EtherEdgeKind, { exact: true }),
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
// readers. Applied on every save.
export const applyMirrorLaw = (doc: CanvasDoc): CanvasDoc => ({
  nodes: doc.nodes.map((node) =>
    node.ether?.flags?.includes("blocker") ? { ...node, color: "1" } : node,
  ),
  edges: doc.edges.map((edge) =>
    edge.ether?.kind !== undefined
      ? {
          ...edge,
          label: edge.label ?? edge.ether.kind,
          ...(edge.ether.kind === "blocks" ? { color: "1" as CanvasColor } : {}),
        }
      : edge,
  ),
});
