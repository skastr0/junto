import { Schema } from "effect";
import { HarnessId } from "./managed-terminal-templates";
import { Port } from "./physics/schema";
import {
  EtherArtifacts,
  EtherBoard,
  EtherMessages,
  EtherRequests,
  EtherTasks,
} from "./work-model";

export {
  Artifact,
  BoardAuthor,
  BoardGlanceTopic,
  BoardPost,
  BoardTopic,
  CompletionEvidence,
  DataPart,
  EtherArtifacts,
  EtherBoard,
  EtherMessages,
  EtherRequests,
  EtherTasks,
  FinishCriteria,
  Message,
  MessageRole,
  Part,
  RawPart,
  Task,
  TaskProposal,
  TaskState,
  TextPart,
  UrlPart,
  WorkArtifacts,
  WorkBoard,
  WorkMessages,
  WorkMetadata,
  WorkRequests,
  WorkSnapshot,
  WorkTasks,
} from "./work-model";

// JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/) plus the namespaced
// `ether` extension. Invariant: a document stripped of every `ether` key must
// remain a valid, readable JSON Canvas 1.0 file.

export const CanvasColor = Schema.String;
export type CanvasColor = typeof CanvasColor.Type;

export const NodeSide = Schema.Literal("top", "right", "bottom", "left");
export type NodeSide = typeof NodeSide.Type;

export const EdgeEnd = Schema.Literal("none", "arrow");
export type EdgeEnd = typeof EdgeEnd.Type;

// Live edge phase — DERIVED from criteria (+ live task/trust state).
// Never authorial: document stores criteria; evaluation produces phase.
// `depends` is retired (no cascade); clear criteria → relates.
export const EdgePhase = Schema.Literal("blocks", "relates");
export type EdgePhase = typeof EdgePhase.Type;
/** Alias used by theme/svg color maps. */
export type EtherEdgeKind = EdgePhase;
export const EtherEdgeKind = EdgePhase;

export const EtherFlag = Schema.Literal("blocker", "parked", "attention");
export type EtherFlag = typeof EtherFlag.Type;

// entity.kind is an open vocabulary; well-known kinds get richer rendering.
// `project` is retired as a well-known kind (degrades to furniture / plain note).
export const WELL_KNOWN_ENTITY_KINDS = [
  "orbit",
  "plugin",
  "agent",
  "station",
  "skill",
  "task",
  "requests",
  "artifacts",
  "board",
  "herdr",
  "terminal",
  "page",
  "watcher",
  "timer",
  "cron",
  "relay",
] as const;

// Bound herdr work surface (PTY pane on a host). Not a hermes agent binding;
// metadata hydration is an explicit adapter call.
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

// Bound Vellum Command-owned terminal work surface (flat session binding).
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
  /**
   * Managed-agent harness id — closed literal, so a harness always names a
   * real template (`HarnessId`); an unknown id fails the document decode
   * rather than reaching spawn. Absent on a raw geography terminal, which is
   * a shell and has no harness; required on the actor seat, where
   * `ManagedAgentNode` types it as present.
   */
  harness: Schema.optionalWith(HarnessId, { exact: true }),
  /**
   * Harness session/thread id for cold wake.
   * Pin harnesses (Claude/Grok): minted at authoring, passed as --session-id.
   * Capture harnesses (Codex/Hermes): written when runtime observes the id.
   */
  sessionId: Schema.optionalWith(Schema.String, { exact: true }),
});
export type EtherTerminal = typeof EtherTerminal.Type;

/** Resolve onDelete with product default `detach` when the field is omitted. */
export const resolveTerminalOnDelete = (
  terminal: EtherTerminal | undefined,
): TerminalOnDelete => terminal?.onDelete ?? "detach";

// Bound browser page work surface. Document holds profile *name* only —
// cookies live in ~/.vellum/browser (runtime), never in the canvas document.
// Native JSON Canvas type remains `link` (url); kind "page" + ether.browser
// upgrade the node to an in-app session binding. onDelete default is
// kill-session: deleting the page node closes the Vellum Command-owned session for
// that ref (Phase 5). Operators may still author onDelete: "detach" to keep a
// warm session when removing the card only. Cookies remain profile-local.
export const BrowserOnDelete = Schema.Literal("detach", "kill-session");
export type BrowserOnDelete = typeof BrowserOnDelete.Type;

export const EtherBrowser = Schema.Struct({
  profile: Schema.String,
  onDelete: Schema.optionalWith(BrowserOnDelete, { exact: true }),
});
export type EtherBrowser = typeof EtherBrowser.Type;

/** Resolve onDelete with product default `kill-session` when the field is omitted. */
export const resolveBrowserOnDelete = (browser: EtherBrowser | undefined): BrowserOnDelete =>
  browser?.onDelete ?? "kill-session";

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

// Authorial host stamp for executable nodes (agent, herdr, page, watcher, timer).
// Same alphabet as remote-hosts HostId. Absence means "local" at resolve time
// (see shared/station resolveNodeHostId) so existing canvases stay valid.
export const EtherHostId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.pattern(/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
export type EtherHostId = typeof EtherHostId.Type;

// Spawn defaults for work-surface nodes created *inside* a region.
// Applied only at create time (stamp source) — never a live parent scope.
// Herdr stops before pane: pane is the instance; host/session/workspace are the place.
// Page stamps start url + browser profile + physical host (cookies stay runtime).
// Paths stamp actor cwd (agent/terminal) keyed by host — different machines
// often need different absolute paths for the same logical project.
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
  host: Schema.optionalWith(EtherHostId, { exact: true }),
});
export type EtherRegionPageDefaults = typeof EtherRegionPageDefaults.Type;

/** host id → absolute cwd on that host for actor spawn. */
export const EtherRegionPaths = Schema.Record({
  key: Schema.String,
  value: Schema.String,
});
export type EtherRegionPaths = typeof EtherRegionPaths.Type;

export const EtherRegionDefaults = Schema.Struct({
  herdr: Schema.optionalWith(EtherRegionHerdrDefaults, { exact: true }),
  page: Schema.optionalWith(EtherRegionPageDefaults, { exact: true }),
  /** Per-host default working directory for agents/terminals created inside. */
  paths: Schema.optionalWith(EtherRegionPaths, { exact: true }),
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
// `defaults` is a create-time stamp source for herdr/page/path bags on nodes
// placed inside the region. Herdr/page bags are bag-atomic (innermost region
// with a bag for that kind wins). Paths are host-keyed: innermost region that
// defines a path for the spawn host wins; missing hosts walk outward.
export const EtherRegion = Schema.Struct({
  hold: Schema.optionalWith(Schema.Boolean, { exact: true }),
  instruction: Schema.optionalWith(Schema.String, { exact: true }),
  defaults: Schema.optionalWith(EtherRegionDefaults, { exact: true }),
});
export type EtherRegion = typeof EtherRegion.Type;

// Gauge (entity.kind watcher): predicate over live hermes roster stats.
// Runtime state is derived, never stored. Live kind is only stat_threshold.
// Retired glyph kinds and private-source watchers fail strict decode.
export const WatchKind = Schema.Literal("stat_threshold");
export type WatchKind = typeof WatchKind.Type;

export const EtherWatch = Schema.Struct({
  kind: WatchKind,
  // Numeric comparison on a bound hermes entity
  source: Schema.optionalWith(Schema.Literal("hermes"), { exact: true }),
  key: Schema.optionalWith(Schema.String, { exact: true }),
  stat: Schema.optionalWith(Schema.String, { exact: true }),
  op: Schema.optionalWith(Schema.Literal("gt", "lt", "eq"), { exact: true }),
  value: Schema.optionalWith(Schema.Number, { exact: true }),
  // Level watchers may mirror unsatisfied into a blocker flag on THIS node
  // (display seed; schedulers are not blockable seats).
  flagOnUnsatisfied: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type EtherWatch = typeof EtherWatch.Type;

// Cron schedule body (entity.kind cron | timer). Interval only for v1;
// calendar schedules require an explicit catch-up + TZ contract first.
export const EtherTimer = Schema.Struct({
  everyMinutes: Schema.Number,
});
export type EtherTimer = typeof EtherTimer.Type;

/**
 * Relay: watch another canvas node's typed projection.
 * Fires rising-edge into satisfied when the predicate holds (same law as gauge).
 */
export const EtherRelay = Schema.Struct({
  /** Node id whose projection is watched (same canvas). */
  sourceNodeId: Schema.String,
  /**
   * Closed projection paths:
   * - task_state: a task sink item reaches `equals` state (default completed)
   * - flags: source node carries flag `equals` (blocker|parked|attention)
   */
  path: Schema.Literal("task_state", "flags"),
  /** Task item id when path is task_state. Absent = any item matching equals. */
  itemId: Schema.optionalWith(Schema.String, { exact: true }),
  /** Expected state or flag name depending on path. */
  equals: Schema.optionalWith(Schema.String, { exact: true }),
});
export type EtherRelay = typeof EtherRelay.Type;

// Automation effect plane (sibling of criteria/ports/notify). Kernel-home fire
// applies these; never process-bind ocap. Claim assignment stays factory tick.
export const EdgeEffectEnqueueTask = Schema.Struct({
  mode: Schema.Literal("enqueue_task"),
  brief: Schema.String,
  reason: Schema.optionalWith(Schema.String, { exact: true }),
});
export type EdgeEffectEnqueueTask = typeof EdgeEffectEnqueueTask.Type;

export const EdgeEffectSetFlag = Schema.Struct({
  mode: Schema.Literal("set_flag"),
  flag: EtherFlag,
  /** true = enable, false = clear. "mirror" = pending→on / satisfied→off for level sensors. */
  enabled: Schema.Union(Schema.Boolean, Schema.Literal("mirror")),
});
export type EdgeEffectSetFlag = typeof EdgeEffectSetFlag.Type;

export const EdgeEffect = Schema.Union(EdgeEffectEnqueueTask, EdgeEffectSetFlag);
export type EdgeEffect = typeof EdgeEffect.Type;

// Work read plane — normalized WorkService rows are projected into these
// fields for renderer/kernel consumers. They remain part of the composed
// CanvasDoc shape, but authorial persistence and Station portfolio boundaries
// reject them. Old checklist {id,text,done} is dead and fails decode.

// Edge criteria. Absence → soft relates (capability only; never stoppage).
// Retired modes (glyphs/wip criteria, depends phase) fail decode. No dependency cascade.
// - tasks:    attention (input-required) generates blocks on actors
// - proof:    holds until a matching runtime stamp on the source sink
// - approval: holds until a human grant (external principal; never a node)
export const EdgeCriteriaTasks = Schema.Struct({
  mode: Schema.Literal("tasks"),
  // empty/absent itemIds = every item on the fromNode tasks/requests list
  itemIds: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
});
export type EdgeCriteriaTasks = typeof EdgeCriteriaTasks.Type;

/** Phase holds until a matching stamp exists in source-sink runtime state. */
export const EdgeCriteriaProof = Schema.Struct({
  mode: Schema.Literal("proof"),
  /** Step name the stamp must claim. */
  step: Schema.String,
  /**
   * When set, stamp.inputsHash must equal this value (gates replay of an old
   * stamp against new inputs). Absent = any stamp for `step` clears.
   */
  inputsHash: Schema.optionalWith(Schema.String, { exact: true }),
});
export type EdgeCriteriaProof = typeof EdgeCriteriaProof.Type;

/** Phase holds until a human grant is recorded for `step` (operator surface). */
export const EdgeCriteriaApproval = Schema.Struct({
  mode: Schema.Literal("approval"),
  step: Schema.String,
});
export type EdgeCriteriaApproval = typeof EdgeCriteriaApproval.Type;

export const EdgeCriteria = Schema.Union(
  EdgeCriteriaTasks,
  EdgeCriteriaProof,
  EdgeCriteriaApproval,
);
export type EdgeCriteria = typeof EdgeCriteria.Type;

/**
 * Operator-assigned claim-routing label on a seat or task sink.
 * Distinct from physics FactoryRole (actor/sink/… derived from kind).
 * Empty/absent = unassigned (any free edged actor may claim if tick allows).
 */
export const WorkRole = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64));
export type WorkRole = typeof WorkRole.Type;

export const EtherNodeExtension = Schema.Struct({
  entity: Schema.optionalWith(EtherEntity, { exact: true }),
  flags: Schema.optionalWith(Schema.Array(EtherFlag), { exact: true }),
  region: Schema.optionalWith(EtherRegion, { exact: true }),
  watch: Schema.optionalWith(EtherWatch, { exact: true }),
  timer: Schema.optionalWith(EtherTimer, { exact: true }),
  relay: Schema.optionalWith(EtherRelay, { exact: true }),
  tasks: Schema.optionalWith(EtherTasks, { exact: true }),
  requests: Schema.optionalWith(EtherRequests, { exact: true }),
  artifacts: Schema.optionalWith(EtherArtifacts, { exact: true }),
  messages: Schema.optionalWith(EtherMessages, { exact: true }),
  /** Runtime overlay for entity.kind === "board" (glance only; SQLite owns truth). */
  board: Schema.optionalWith(EtherBoard, { exact: true }),
  // Geography display binding for entity.kind === "herdr". This is not a seat:
  // a herdr pane renders and shows state, and holds no port.
  herdr: Schema.optionalWith(EtherHerdr, { exact: true }),
  /**
   * Work-surface binding for entity.kind === "terminal" (raw geography) OR
   * entity.kind === "agent" (managed seat). The **agent** seat requires
   * bindingId + harness — that requirement is carried by `ManagedAgentNode`
   * (shared/actor-surface.ts), never by the decoder: decode reads the
   * document, it does not rewrite what the document means.
   * Host lives in ether.host (station truth); do not duplicate host here.
   */
  terminal: Schema.optionalWith(EtherTerminal, { exact: true }),
  // Work-surface binding for entity.kind === "page" on a link node.
  browser: Schema.optionalWith(EtherBrowser, { exact: true }),
  // Host that may execute/tool this node. Optional for graceful degradation.
  host: Schema.optionalWith(EtherHostId, { exact: true }),
  // Operator-authored claim-routing role (not physics FactoryRole).
  workRole: Schema.optionalWith(WorkRole, { exact: true }),
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
  /**
   * Operator-authored wake eligibility for board megaphone.
   * Not a Port — delivery plane, not capability. Absent = false.
   */
  notify: Schema.optionalWith(Schema.Boolean, { exact: true }),
  /**
   * Scheduler automation effect. Applied by the kernel on home-local fire.
   * Not a Port and not criteria. Soft relates without effect still do nothing.
   */
  effect: Schema.optionalWith(EdgeEffect, { exact: true }),
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

const decodeCanvasDocStrict = Schema.decodeUnknownEither(CanvasDoc, {
  onExcessProperty: "error",
});
export const encodeCanvasDoc = Schema.encodeEither(CanvasDoc);

const WORK_PROJECTION_KEYS = [
  "tasks",
  "requests",
  "messages",
  "artifacts",
  "board",
] as const;

/**
 * Runtime work projections share CanvasDoc with authorial intent so composed
 * readers have one shape. Persistence boundaries use this detector before
 * decode because a valid projected store must never become durable intent.
 */
export const containsWorkProjection = (input: unknown): boolean => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const nodes = (input as { readonly nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.some((node) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return false;
    }
    const ether = (node as { readonly ether?: unknown }).ether;
    if (ether === null || typeof ether !== "object" || Array.isArray(ether)) {
      return false;
    }
    return WORK_PROJECTION_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(ether, key),
    );
  });
};

export const decodeCanvasDoc = (
  input: unknown,
): ReturnType<typeof decodeCanvasDocStrict> => decodeCanvasDocStrict(input);

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
// readers. Applied on every save. Edge ether.kind is the machine-readable
// phase mirror and color "1" its visual projection; `label` stays authorial.
export const applyMirrorLaw = (doc: CanvasDoc): CanvasDoc => ({
  nodes: doc.nodes.map((node) =>
    node.ether?.flags?.includes("blocker") ? { ...node, color: "1" } : node,
  ),
  edges: doc.edges.map((edge) => {
    const kind = edge.ether?.kind;
    if (kind === undefined) return edge;
    if (kind === "blocks") {
      return { ...edge, color: "1" as CanvasColor };
    }
    // Leaving blocks: drop mirror crimson "1" so demotion is visible offline.
    if (edge.color === "1") {
      const { color: _c, ...rest } = edge;
      return rest;
    }
    return edge;
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
