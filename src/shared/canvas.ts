import { Schema } from "effect";
import { Port } from "./physics/schema";

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

// entity.kind is an open vocabulary; well-known kinds get richer rendering.
export const WELL_KNOWN_ENTITY_KINDS = [
  "project",
  "orbit",
  "plugin",
  "agent",
  "station",
  "skill",
  "task",
  "requests",
  "artifacts",
  "herdr",
  "terminal",
  "page",
  "watcher",
  "timer",
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

// Bound Vellum-owned terminal work surface (flat session binding).
// Document stores stable bindingId + optional launch profile only.
// Runtime owns epochs/PTYs/presentation — never PIDs, sockets, or scrollback here.
// onDelete default is detach: removing the card does not kill while the app lives;
// app quit stops local native sessions by product law.
export const TerminalOnDelete = Schema.Literal("detach", "kill-session");
export type TerminalOnDelete = typeof TerminalOnDelete.Type;

export const TerminalLaunchKind = Schema.Literal("shell", "command", "harness");
export type TerminalLaunchKind = typeof TerminalLaunchKind.Type;

export const EtherTerminalLaunch = Schema.Struct({
  kind: TerminalLaunchKind,
  argv: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
  cwd: Schema.optionalWith(Schema.String, { exact: true }),
  env: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.String }),
    { exact: true },
  ),
});
export type EtherTerminalLaunch = typeof EtherTerminalLaunch.Type;

export const EtherTerminal = Schema.Struct({
  /** Stable authorial identity (ULID). Not a runtime epoch/session instance id. */
  bindingId: Schema.String,
  label: Schema.optionalWith(Schema.String, { exact: true }),
  onDelete: Schema.optionalWith(TerminalOnDelete, { exact: true }),
  /** Optional launch profile — inert until deliberate Start (never auto-exec on load). */
  launch: Schema.optionalWith(EtherTerminalLaunch, { exact: true }),
});
export type EtherTerminal = typeof EtherTerminal.Type;

/** Resolve onDelete with product default `detach` when the field is omitted. */
export const resolveTerminalOnDelete = (
  terminal: EtherTerminal | undefined,
): TerminalOnDelete => terminal?.onDelete ?? "detach";

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

// `name` is the node's IMMUTABLE identity — the join key against the live
// corpus (shared/connections.ts resolves every source connection from it at
// read time; nothing per-source is ever stored). The node's visible text
// label is free to change; `name` is stamped at creation and never edited by
// label mutations. For kind "agent" it is the hermes "<host>:<profile>" key.
// Kinds that don't join the corpus (watcher, timer, task, …) omit it.
export const EtherEntity = Schema.Struct({
  kind: Schema.String,
  name: Schema.optionalWith(Schema.String, { exact: true }),
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

// Spawn defaults for work-surface nodes created *inside* a region.
// Applied only at create time (stamp source) — never a live parent scope.
// Herdr stops before pane: pane is the instance; host/session/workspace are the place.
// Page stamps start url + browser profile name only (cookies stay runtime).
export const EtherRegionHerdrDefaults = Schema.Struct({
  host: Schema.String,
  session: Schema.optionalWith(Schema.NullOr(Schema.String), { exact: true }),
  workspaceId: Schema.optionalWith(Schema.String, { exact: true }),
  tabId: Schema.optionalWith(Schema.String, { exact: true }),
});
export type EtherRegionHerdrDefaults = typeof EtherRegionHerdrDefaults.Type;

export const EtherRegionPageDefaults = Schema.Struct({
  url: Schema.optionalWith(Schema.String, { exact: true }),
  profile: Schema.optionalWith(Schema.String, { exact: true }),
});
export type EtherRegionPageDefaults = typeof EtherRegionPageDefaults.Type;

export const EtherRegionDefaults = Schema.Struct({
  herdr: Schema.optionalWith(EtherRegionHerdrDefaults, { exact: true }),
  page: Schema.optionalWith(EtherRegionPageDefaults, { exact: true }),
});
export type EtherRegionDefaults = typeof EtherRegionDefaults.Type;

// Region behavior (group nodes only). `hold: true` makes the region a
// structural container: nodes spatially inside it travel with it when it
// moves. `instruction` is the region's pulse briefing: when the region
// activates (a watcher fires, a timer ticks, or a manual pulse), every agent
// node inside receives it. Membership itself is always DERIVED from geometry
// at interaction time — never stored — so the document cannot go incoherent.
// ARMING deliberately does NOT live in the document: definitions travel with
// the file; the switch that lets a pulse spend real agent turns exists only
// in the running app, flipped by a human.
// `defaults` is a create-time stamp source for herdr/page nodes placed inside
// the region — bag-atomic (innermost region with a bag for that kind wins).
export const EtherRegion = Schema.Struct({
  hold: Schema.optionalWith(Schema.Boolean, { exact: true }),
  instruction: Schema.optionalWith(Schema.String, { exact: true }),
  defaults: Schema.optionalWith(EtherRegionDefaults, { exact: true }),
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

// A2A work plane — document-local tasks / requests / artifacts / messages.
// State lives in the document. Incomplete tasks and pending requests do NOT
// auto-seed blocks — only an edge whose criteria mode is "tasks" can turn
// them into a generating relation. Old checklist {id,text,done} is dead:
// invalid store keys are dropped on read (graceful degradation), never mapped.

export const TextPart = Schema.Struct({
  kind: Schema.Literal("text"),
  text: Schema.String,
});
export type TextPart = typeof TextPart.Type;

export const UrlPart = Schema.Struct({
  kind: Schema.Literal("url"),
  url: Schema.String,
  mediaType: Schema.optionalWith(Schema.String, { exact: true }),
});
export type UrlPart = typeof UrlPart.Type;

export const DataPart = Schema.Struct({
  kind: Schema.Literal("data"),
  data: Schema.Unknown,
});
export type DataPart = typeof DataPart.Type;

export const RawPart = Schema.Struct({
  kind: Schema.Literal("raw"),
  bytesBase64: Schema.String,
  mediaType: Schema.optionalWith(Schema.String, { exact: true }),
});
export type RawPart = typeof RawPart.Type;

export const Part = Schema.Union(TextPart, UrlPart, DataPart, RawPart);
export type Part = typeof Part.Type;

export const MessageRole = Schema.Literal("user", "agent");
export type MessageRole = typeof MessageRole.Type;

export const A2AMetadata = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export type A2AMetadata = typeof A2AMetadata.Type;

export const Message = Schema.Struct({
  messageId: Schema.String,
  role: MessageRole,
  parts: Schema.Array(Part),
  taskId: Schema.optionalWith(Schema.String, { exact: true }),
  contextId: Schema.optionalWith(Schema.String, { exact: true }),
  referenceTaskIds: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
  metadata: Schema.optionalWith(A2AMetadata, { exact: true }),
});
export type Message = typeof Message.Type;

export const TaskState = Schema.Literal(
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
  "auth-required",
);
export type TaskState = typeof TaskState.Type;

export const A2ATask = Schema.Struct({
  id: Schema.String,
  state: TaskState,
  history: Schema.Array(Message),
  artifactIds: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
  metadata: Schema.optionalWith(A2AMetadata, { exact: true }),
});
export type A2ATask = typeof A2ATask.Type;

export const Artifact = Schema.Struct({
  artifactId: Schema.String,
  name: Schema.optionalWith(Schema.String, { exact: true }),
  parts: Schema.Array(Part),
  taskId: Schema.optionalWith(Schema.String, { exact: true }),
  metadata: Schema.optionalWith(A2AMetadata, { exact: true }),
});
export type Artifact = typeof Artifact.Type;

/** Tasks node store (entity.kind === "task"). */
export const EtherTasks = Schema.Struct({
  items: Schema.Array(A2ATask),
});
export type EtherTasks = typeof EtherTasks.Type;

/** Requests node store (entity.kind === "requests") — items live around input-required. */
export const EtherRequests = Schema.Struct({
  items: Schema.Array(A2ATask),
});
export type EtherRequests = typeof EtherRequests.Type;

/** Artifacts node store (entity.kind === "artifacts"). */
export const EtherArtifacts = Schema.Struct({
  items: Schema.Array(Artifact),
});
export type EtherArtifacts = typeof EtherArtifacts.Type;

/** Per-agent / herdr message list (entity.kind === "agent" | "herdr"). */
export const EtherMessages = Schema.Struct({
  items: Schema.Array(Message),
});
export type EtherMessages = typeof EtherMessages.Type;

// Edge glyph-binding / task-binding criteria. Absence → plain relates.
// - glyphs: selected glyph ids on a project must all be "done"
// - wip:    opt-in; any glyph in committed|building|reviewing generates blocks
// - tasks:  from task node → selected items not "completed";
//           from requests node → selected items still "input-required"
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
  // empty/absent itemIds = every item on the fromNode tasks/requests list
  itemIds: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
});
export type EdgeCriteriaTasks = typeof EdgeCriteriaTasks.Type;

export const EdgeCriteria = Schema.Union(EdgeCriteriaGlyphs, EdgeCriteriaWip, EdgeCriteriaTasks);
export type EdgeCriteria = typeof EdgeCriteria.Type;

// Authorial host stamp for executable nodes (agent, herdr, page, watcher, timer).
// Same alphabet as remote-hosts HostId. Absence means "local" at resolve time
// (see shared/station resolveNodeHostId) so existing canvases stay valid.
export const EtherHostId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.pattern(/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
export type EtherHostId = typeof EtherHostId.Type;

export const EtherNodeExtension = Schema.Struct({
  entity: Schema.optionalWith(EtherEntity, { exact: true }),
  flags: Schema.optionalWith(Schema.Array(EtherFlag), { exact: true }),
  view: Schema.optionalWith(EtherView, { exact: true }),
  region: Schema.optionalWith(EtherRegion, { exact: true }),
  watch: Schema.optionalWith(EtherWatch, { exact: true }),
  timer: Schema.optionalWith(EtherTimer, { exact: true }),
  tasks: Schema.optionalWith(EtherTasks, { exact: true }),
  requests: Schema.optionalWith(EtherRequests, { exact: true }),
  artifacts: Schema.optionalWith(EtherArtifacts, { exact: true }),
  messages: Schema.optionalWith(EtherMessages, { exact: true }),
  // Work-surface binding for entity.kind === "herdr". Not an EntitySource.
  herdr: Schema.optionalWith(EtherHerdr, { exact: true }),
  // Work-surface binding for entity.kind === "terminal". Not an EntitySource.
  // Host lives in ether.host (station truth); do not duplicate host here.
  terminal: Schema.optionalWith(EtherTerminal, { exact: true }),
  // Work-surface binding for entity.kind === "page" on a link node. Not an EntitySource.
  browser: Schema.optionalWith(EtherBrowser, { exact: true }),
  // Host that may execute/tool this node. Optional for graceful degradation.
  host: Schema.optionalWith(EtherHostId, { exact: true }),
});
export type EtherNodeExtension = typeof EtherNodeExtension.Type;

export const EtherEdgeExtension = Schema.Struct({
  // Authorial: only criteria. Absence = soft relates (never generates/relays).
  criteria: Schema.optionalWith(EdgeCriteria, { exact: true }),
  // Derived mirror of last live phase for offline JSON Canvas readers.
  // Written only by applyPhaseMirror — never set by authoring UI.
  kind: Schema.optionalWith(EdgePhase, { exact: true }),
  // Authorial ocap attenuation: subset of Port strings. Absence = full offers
  // (default grant). Strip ether → still valid JSON Canvas 1.0.
  ports: Schema.optionalWith(Schema.Array(Port), { exact: true }),
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

const decodeCanvasDocStrict = Schema.decodeUnknownEither(CanvasDoc);
export const encodeCanvasDoc = Schema.encodeEither(CanvasDoc);

// Work-store keys that must decode as A2A shapes. A pre-existing doc whose
// ether.tasks (etc.) fails the schema drops that key on read — never mapped
// or shimmed. Other ether fields still decode strictly.
const workStoreDecoders: ReadonlyArray<{
  readonly key: "tasks" | "requests" | "artifacts" | "messages";
  readonly decode: (value: unknown) => { readonly _tag: "Left" | "Right" };
}> = [
  { key: "tasks", decode: Schema.decodeUnknownEither(EtherTasks) },
  { key: "requests", decode: Schema.decodeUnknownEither(EtherRequests) },
  { key: "artifacts", decode: Schema.decodeUnknownEither(EtherArtifacts) },
  { key: "messages", decode: Schema.decodeUnknownEither(EtherMessages) },
];

/** Drop invalid A2A work stores before full document decode. */
export const sanitizeWorkStores = (input: unknown): unknown => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const doc = input as Record<string, unknown>;
  if (!Array.isArray(doc.nodes)) return input;
  let anyNodeChanged = false;
  const nodes = doc.nodes.map((node) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return node;
    const n = node as Record<string, unknown>;
    if (n.ether === null || typeof n.ether !== "object" || Array.isArray(n.ether)) return node;
    const etherIn = n.ether as Record<string, unknown>;
    let storeDropped = false;
    const ether: Record<string, unknown> = { ...etherIn };
    for (const { key, decode } of workStoreDecoders) {
      if (!(key in ether)) continue;
      if (decode(ether[key])._tag === "Left") {
        delete ether[key];
        storeDropped = true;
      }
    }
    if (!storeDropped) return node;
    anyNodeChanged = true;
    if (Object.keys(ether).length === 0) {
      const { ether: _dropped, ...rest } = n;
      return rest;
    }
    return { ...n, ether };
  });
  return anyNodeChanged ? { ...doc, nodes } : input;
};

export const decodeCanvasDoc = (
  input: unknown,
): ReturnType<typeof decodeCanvasDocStrict> => decodeCanvasDocStrict(sanitizeWorkStores(input));

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
