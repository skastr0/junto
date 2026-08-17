import { Schema } from "effect";
import { HarnessId } from "./managed-terminal-templates";
import { Port } from "./physics/schema";
import {
  EtherArtifacts,
  EtherBoard,
  EtherMessages,
  EtherPad,
  EtherRequests,
  EtherTasks,
} from "./work-model";
import { scrubDoesEffect } from "./node-insert";

export {
  Artifact,
  BoardAuthor,
  BoardGlanceTopic,
  BoardPost,
  BoardTopic,
  ContentAvailability,
  ContentByteLength,
  ContentCorrupt,
  ContentDisplayName,
  ContentIdentity,
  ContentLocalPathProjection,
  ContentMediaType,
  ContentMissing,
  ContentObject,
  ContentPart,
  ContentPathProjection,
  ContentReceipt,
  ContentRef,
  ContentSha256,
  ContentUnavailable,
  ContentTimestamp,
  decodeContentPart,
  CompletionEvidence,
  DataPart,
  EtherArtifacts,
  EtherBoard,
  EtherMessages,
  EtherPad,
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
  isContentPart,
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

export const NodeSide = Schema.Literals(["top", "right", "bottom", "left"]);
export type NodeSide = typeof NodeSide.Type;

export const EdgeEnd = Schema.Literals(["none", "arrow"]);
export type EdgeEnd = typeof EdgeEnd.Type;

// Live edge phase — DERIVED from criteria (+ live task/trust state).
// Never authorial: document stores criteria; evaluation produces phase.
// `depends` is retired (no cascade); clear criteria → relates.
export const EdgePhase = Schema.Literals(["blocks", "relates"]);
export type EdgePhase = typeof EdgePhase.Type;
/** Alias used by theme/svg color maps. */
export type EtherEdgeKind = EdgePhase;
export const EtherEdgeKind = EdgePhase;

export const EtherFlag = Schema.Literals(["blocker", "parked", "attention"]);
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
  "pad",
  "herdr",
  "terminal",
  "page",
  "watcher",
  "timer",
  "cron",
  "relay",
  // Geography furniture: bare map text. Not a physics KindSpecs key — role
  // stays geography via open-vocab resolveSpec (same as notes / unknown kinds).
  "label",
] as const;

// Bound herdr work surface (PTY pane on a host). Not a hermes agent binding;
// metadata hydration is an explicit adapter call.
// onDelete default is detach: removing the canvas card must not kill the pane.
export const HerdrOnDelete = Schema.Literals(["detach", "kill-pane"]);
export type HerdrOnDelete = typeof HerdrOnDelete.Type;

export const EtherHerdr = Schema.Struct({
  host: Schema.String,
  session: Schema.optionalKey(Schema.NullOr(Schema.String)),
  workspaceId: Schema.optionalKey(Schema.String),
  tabId: Schema.optionalKey(Schema.String),
  // Required once bound; optional so partially-authored nodes can decode.
  paneId: Schema.optionalKey(Schema.String),
  terminalId: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  onDelete: Schema.optionalKey(HerdrOnDelete),
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
export const TerminalOnDelete = Schema.Literals(["detach", "kill-session"]);
export type TerminalOnDelete = typeof TerminalOnDelete.Type;

export const TerminalLaunchKind = Schema.Literals(["shell", "command", "harness"]);
export type TerminalLaunchKind = typeof TerminalLaunchKind.Type;

export const EtherTerminalLaunch = Schema.Struct({
  kind: TerminalLaunchKind,
  argv: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type EtherTerminalLaunch = typeof EtherTerminalLaunch.Type;

export const EtherTerminal = Schema.Struct({
  /** Stable authorial identity (ULID). Not a runtime epoch/session instance id. */
  bindingId: Schema.String,
  label: Schema.optionalKey(Schema.String),
  onDelete: Schema.optionalKey(TerminalOnDelete),
  /** Optional launch profile — inert until deliberate Start (never auto-exec on load). */
  launch: Schema.optionalKey(EtherTerminalLaunch),
  /**
   * Managed-agent harness id — closed literal, so a harness always names a
   * real template (`HarnessId`); an unknown id fails the document decode
   * rather than reaching spawn. Absent on a raw geography terminal, which is
   * a shell and has no harness; required on the actor seat, where
   * `ManagedAgentNode` types it as present.
   */
  harness: Schema.optionalKey(HarnessId),
  /**
   * Harness session/thread id for cold wake.
   * Pin harnesses (Claude/Grok): minted at authoring, passed as --session-id.
   * Capture harnesses (Codex/Hermes): written when runtime observes the id.
   */
  sessionId: Schema.optionalKey(Schema.String),
});
export type EtherTerminal = typeof EtherTerminal.Type;

/** Resolve onDelete with product default `detach` when the field is omitted. */
export const resolveTerminalOnDelete = (
  terminal: EtherTerminal | undefined,
): TerminalOnDelete => terminal?.onDelete ?? "detach";

// Bound browser page work surface. Document holds profile *name* only —
// cookies live in ~/.vellum-command/browser (runtime), never in the canvas document.
// Native JSON Canvas type remains `link` (url); kind "page" + ether.browser
// upgrade the node to an in-app session binding. onDelete default is
// kill-session: deleting the page node closes the Vellum Command-owned session for
// that ref (Phase 5). Operators may still author onDelete: "detach" to keep a
// warm session when removing the card only. Cookies remain profile-local.
export const BrowserOnDelete = Schema.Literals(["detach", "kill-session"]);
export type BrowserOnDelete = typeof BrowserOnDelete.Type;

export const EtherBrowser = Schema.Struct({
  profile: Schema.String,
  onDelete: Schema.optionalKey(BrowserOnDelete),
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
  name: Schema.optionalKey(Schema.String),
});
export type EtherEntity = typeof EtherEntity.Type;

// Authorial host stamp for executable nodes (agent, herdr, page, watcher, timer).
// Same alphabet as remote-hosts HostId. Absence means "local" at resolve time
// (see shared/station resolveNodeHostId) so existing canvases stay valid.
export const EtherHostId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/)),
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
  session: Schema.optionalKey(Schema.NullOr(Schema.String)),
  workspaceId: Schema.optionalKey(Schema.String),
  tabId: Schema.optionalKey(Schema.String),
});
export type EtherRegionHerdrDefaults = typeof EtherRegionHerdrDefaults.Type;

export const EtherRegionPageDefaults = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(EtherHostId),
});
export type EtherRegionPageDefaults = typeof EtherRegionPageDefaults.Type;

/** host id → absolute cwd on that host for actor spawn. */
export const EtherRegionPaths = Schema.Record(Schema.String, Schema.String);
export type EtherRegionPaths = typeof EtherRegionPaths.Type;

export const EtherRegionDefaults = Schema.Struct({
  herdr: Schema.optionalKey(EtherRegionHerdrDefaults),
  page: Schema.optionalKey(EtherRegionPageDefaults),
  /** Per-host default working directory for agents/terminals created inside. */
  paths: Schema.optionalKey(EtherRegionPaths),
});
export type EtherRegionDefaults = typeof EtherRegionDefaults.Type;

// Region behavior (group nodes only). `hold: true` makes the region a
// structural container: nodes spatially inside it travel with it when it
// moves. `instruction` is optional operator briefing text for agents inside
// the region — surfaced on work-control `onboard` (not auto-injected).
// Membership itself is always DERIVED from geometry at interaction time —
// never stored — so the document cannot go incoherent.
// `defaults` is a create-time stamp source for herdr/page/path bags on nodes
// placed inside the region. Herdr/page bags are bag-atomic (innermost region
// with a bag for that kind wins). Paths are host-keyed: innermost region that
// defines a path for the spawn host wins; missing hosts walk outward.
export const EtherRegion = Schema.Struct({
  hold: Schema.optionalKey(Schema.Boolean),
  instruction: Schema.optionalKey(Schema.String),
  defaults: Schema.optionalKey(EtherRegionDefaults),
});
export type EtherRegion = typeof EtherRegion.Type;

// Gauge body (entity.kind watcher) — PRODUCT-DORMANT.
// Hermes roster/stats feed agent fleet join, not the automation product.
// This shape still decodes for existing boards; palette hides new gauges.
// Do NOT describe product schedulers as "cron / hermes gauge / relay".
// Live product sensors: cron (time) + relay (canvas node projection).
// Future external-input actuator (webhook/poll) is a new surface, not this stub.
// Runtime state is derived, never stored. Live kind is only stat_threshold.
// Retired glyph kinds and private-source watchers fail strict decode.
export const WatchKind = Schema.Literal("stat_threshold");
export type WatchKind = typeof WatchKind.Type;

export const EtherWatch = Schema.Struct({
  kind: WatchKind,
  // Legacy hermes numeric compare — not the product gauge story
  source: Schema.optionalKey(Schema.Literal("hermes")),
  key: Schema.optionalKey(Schema.String),
  stat: Schema.optionalKey(Schema.String),
  op: Schema.optionalKey(Schema.Literals(["gt", "lt", "eq"])),
  value: Schema.optionalKey(Schema.Number),
  // Level watchers may mirror unsatisfied into a blocker flag on THIS node
  // (display seed; schedulers are not blockable seats).
  flagOnUnsatisfied: Schema.optionalKey(Schema.Boolean),
});
export type EtherWatch = typeof EtherWatch.Type;

/**
 * Cron schedule body (entity.kind cron | timer).
 * - `expression`: standard 5-field crontab (preferred).
 * - `everyMinutes`: older interval form; UI/writers emit expression.
 */
export const EtherTimer = Schema.Struct({
  everyMinutes: Schema.optionalKey(Schema.Number),
  /** 5-field cron: minute hour day-of-month month day-of-week. */
  expression: Schema.optionalKey(Schema.String),
});
export type EtherTimer = typeof EtherTimer.Type;

/** Scheduler slot on a wire (assigned by draw direction / config). */
export const WireSlot = Schema.Literals([
  "input",
  "output",
  "trigger",
  "recipient",
]);
export type WireSlot = typeof WireSlot.Type;

/** Watch predicate on input wires (sink→relay). */
export const WatchWhenCompletes = Schema.Struct({
  word: Schema.Literal("completes"),
  /** Task item state; default completed. */
  equals: Schema.optionalKey(Schema.String),
  itemId: Schema.optionalKey(Schema.String),
});
export type WatchWhenCompletes = typeof WatchWhenCompletes.Type;

export const WatchWhenFlagged = Schema.Struct({
  word: Schema.Literal("flagged"),
  flag: EtherFlag,
});
export type WatchWhenFlagged = typeof WatchWhenFlagged.Type;

/** Atomic watch atoms — multi-select OR nests these under `any`. */
export const WatchWhenAtom = Schema.Union([WatchWhenCompletes, WatchWhenFlagged]);
export type WatchWhenAtom = typeof WatchWhenAtom.Type;

/** Multi-select OR within one watch wire. Single atoms still decode alone. */
export const WatchWhenAny = Schema.Struct({
  word: Schema.Literal("any"),
  any: Schema.Array(WatchWhenAtom).pipe(Schema.check(Schema.isMinLength(1))),
});
export type WatchWhenAny = typeof WatchWhenAny.Type;

export const WatchWhen = Schema.Union([
  WatchWhenCompletes,
  WatchWhenFlagged,
  WatchWhenAny,
]);
export type WatchWhen = typeof WatchWhen.Type;

// Automation effect plane (sibling of criteria/ports/notify). Kernel-home fire
// applies these; never process-bind ocap. Claim assignment stays factory tick.
// `data` is opaque on the wire; the target sink's closed create schema is
// decoded fail-closed at apply (EffectTasksCreate / EffectBoard*).
export const EdgeEffectEnqueueTask = Schema.Struct({
  mode: Schema.Literal("enqueue_task"),
  data: Schema.Unknown,
});
export type EdgeEffectEnqueueTask = typeof EdgeEffectEnqueueTask.Type & {
  readonly data: import("./node-insert").EffectTasksCreate | Record<string, unknown>;
};

export const EdgeEffectBoardCreateTopic = Schema.Struct({
  mode: Schema.Literal("board_create_topic"),
  data: Schema.Unknown,
});
export type EdgeEffectBoardCreateTopic = typeof EdgeEffectBoardCreateTopic.Type & {
  readonly data: import("./node-insert").EffectBoardCreateTopic | Record<string, unknown>;
};

export const EdgeEffectBoardPost = Schema.Struct({
  mode: Schema.Literal("board_post"),
  data: Schema.Unknown,
});
export type EdgeEffectBoardPost = typeof EdgeEffectBoardPost.Type & {
  readonly data: import("./node-insert").EffectBoardPost | Record<string, unknown>;
};

export const EdgeEffectSetFlag = Schema.Struct({
  mode: Schema.Literal("set_flag"),
  flag: EtherFlag,
  /** true = enable, false = clear. "mirror" = pending→on / satisfied→off for level sensors. */
  enabled: Schema.Union([Schema.Boolean, Schema.Literal("mirror")]),
});
export type EdgeEffectSetFlag = typeof EdgeEffectSetFlag.Type;

/** Inject a prompt into an agent seat. Text optional — kernel fills from fire provenance. */
export const EdgeEffectInjectPrompt = Schema.Struct({
  mode: Schema.Literal("inject_prompt"),
  text: Schema.optionalKey(Schema.String),
});
export type EdgeEffectInjectPrompt = typeof EdgeEffectInjectPrompt.Type;

export const EdgeEffect = Schema.Union([
  EdgeEffectEnqueueTask,
  EdgeEffectBoardCreateTopic,
  EdgeEffectBoardPost,
  EdgeEffectSetFlag,
  EdgeEffectInjectPrompt,
]);
export type EdgeEffect = typeof EdgeEffect.Type;

// Work read plane — normalized WorkService rows are projected into these
// fields for renderer/kernel consumers. They remain part of the composed
// CanvasDoc shape, but authorial persistence and Station portfolio boundaries
// reject them. Old checklist {id,text,done} is dead and fails decode.

// Edge criteria (decode-history only for tasks stops). Product stoppage for
// actor ↔ task|requests is derived from the access relationship + claimed
// attention — not authored via Hold. proof/approval are retired: scrub drops
// them on load; they fail strict decode if reintroduced.
// Retired modes (glyphs/wip criteria, depends phase, proof, approval) fail
// decode. No dependency cascade.
export const EdgeCriteriaTasks = Schema.Struct({
  mode: Schema.Literal("tasks"),
  // empty/absent itemIds = every item on the fromNode tasks/requests list
  itemIds: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type EdgeCriteriaTasks = typeof EdgeCriteriaTasks.Type;

export const EdgeCriteria = EdgeCriteriaTasks;
export type EdgeCriteria = typeof EdgeCriteria.Type;

export const EtherNodeExtension = Schema.Struct({
  entity: Schema.optionalKey(EtherEntity),
  flags: Schema.optionalKey(Schema.Array(EtherFlag)),
  region: Schema.optionalKey(EtherRegion),
  watch: Schema.optionalKey(EtherWatch),
  timer: Schema.optionalKey(EtherTimer),
  tasks: Schema.optionalKey(EtherTasks),
  requests: Schema.optionalKey(EtherRequests),
  artifacts: Schema.optionalKey(EtherArtifacts),
  messages: Schema.optionalKey(EtherMessages),
  /** Runtime overlay for entity.kind === "board" (glance only; SQLite owns truth). */
  board: Schema.optionalKey(EtherBoard),
  /** Runtime overlay for entity.kind === "pad" (glance only; SQLite owns truth). */
  pad: Schema.optionalKey(EtherPad),
  // Geography display binding for entity.kind === "herdr". This is not a seat:
  // a herdr pane renders and shows state, and holds no port.
  herdr: Schema.optionalKey(EtherHerdr),
  /**
   * Work-surface binding for entity.kind === "terminal" (raw geography) OR
   * entity.kind === "agent" (managed seat). The **agent** seat requires
   * bindingId + harness — that requirement is carried by `ManagedAgentNode`
   * (shared/actor-surface.ts), never by the decoder: decode reads the
   * document, it does not rewrite what the document means.
   * Host lives in ether.host (station truth); do not duplicate host here.
   */
  terminal: Schema.optionalKey(EtherTerminal),
  // Work-surface binding for entity.kind === "page" on a link node.
  browser: Schema.optionalKey(EtherBrowser),
  // Host that may execute/tool this node. Optional for graceful degradation.
  host: Schema.optionalKey(EtherHostId),
});
export type EtherNodeExtension = typeof EtherNodeExtension.Type;

/**
 * Wire areas on edges. Derived (not authorial): sentence, family color, badges.
 * Phase mirror may stamp `kind` for offline JSON Canvas readers only.
 * Canonical words: stops, wake, does, when, slot, ports.
 */
export const EtherEdgeExtension = Schema.Struct({
  ports: Schema.optionalKey(Schema.Array(Port)),
  stops: Schema.optionalKey(EdgeCriteria),
  /** Board links: absent/true = ON; explicit false = OFF. */
  wake: Schema.optionalKey(Schema.Boolean),
  slot: Schema.optionalKey(WireSlot),
  when: Schema.optionalKey(WatchWhen),
  does: Schema.optionalKey(EdgeEffect),
  /** Derived phase mirror for offline readers — never authoring input. */
  kind: Schema.optionalKey(EdgePhase),
});
export type EtherEdgeExtension = typeof EtherEdgeExtension.Type;

export const edgeStops = (
  ether: EtherEdgeExtension | undefined,
): EdgeCriteria | undefined => ether?.stops;

export const edgeWake = (
  ether: EtherEdgeExtension | undefined,
): boolean | undefined => ether?.wake;

export const edgeDoes = (
  ether: EtherEdgeExtension | undefined,
): EdgeEffect | undefined => ether?.does;

const nodeBase = {
  id: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  color: Schema.optionalKey(CanvasColor),
  ether: Schema.optionalKey(EtherNodeExtension),
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
  subpath: Schema.optionalKey(Schema.String),
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
  label: Schema.optionalKey(Schema.String),
  background: Schema.optionalKey(Schema.String),
  backgroundStyle: Schema.optionalKey(Schema.Literals(["cover", "ratio", "repeat"])),
  ...nodeBase,
});
export type GroupNode = typeof GroupNode.Type;

export const CanvasNode = Schema.Union([TextNode, FileNode, LinkNode, GroupNode]);
export type CanvasNode = typeof CanvasNode.Type;

export const CanvasEdge = Schema.Struct({
  id: Schema.String,
  fromNode: Schema.String,
  fromSide: Schema.optionalKey(NodeSide),
  fromEnd: Schema.optionalKey(EdgeEnd),
  toNode: Schema.String,
  toSide: Schema.optionalKey(NodeSide),
  toEnd: Schema.optionalKey(EdgeEnd),
  color: Schema.optionalKey(CanvasColor),
  label: Schema.optionalKey(Schema.String),
  ether: Schema.optionalKey(EtherEdgeExtension),
});
export type CanvasEdge = typeof CanvasEdge.Type;

export const CanvasDoc = Schema.Struct({
  nodes: Schema.Array(CanvasNode),
  edges: Schema.Array(CanvasEdge),
});
export type CanvasDoc = typeof CanvasDoc.Type;

const decodeCanvasDocStrict = Schema.decodeUnknownResult(CanvasDoc, {
  onExcessProperty: "error",
});
export const encodeCanvasDoc = Schema.encodeResult(CanvasDoc);

const WORK_PROJECTION_KEYS = [
  "tasks",
  "requests",
  "messages",
  "artifacts",
  "board",
  "pad",
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

/**
 * Collapse old dual-keys and delete dead node bodies before strict decode.
 * Product shape is one word per area: stops / does / wake / when. Node-body
 * `ether.relay` is not a product surface — watch lives on the wire.
 */
export const scrubCanvasDocInput = (input: unknown): unknown => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const raw = input as {
    readonly nodes?: unknown;
    readonly edges?: unknown;
    readonly [key: string]: unknown;
  };
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.map((node) => {
        if (node === null || typeof node !== "object" || Array.isArray(node)) {
          return node;
        }
        const n = node as { readonly ether?: unknown; readonly [k: string]: unknown };
        const etherIn = n.ether;
        if (
          etherIn === null ||
          typeof etherIn !== "object" ||
          Array.isArray(etherIn)
        ) {
          return node;
        }
        if (!Object.prototype.hasOwnProperty.call(etherIn, "relay")) {
          return node;
        }
        const { relay: _drop, ...ether } = etherIn as Record<string, unknown>;
        if (Object.keys(ether).length === 0) {
          const { ether: _e, ...rest } = n;
          return rest;
        }
        return { ...n, ether };
      })
    : raw.nodes;
  const edges = Array.isArray(raw.edges)
    ? raw.edges.map((edge) => {
        if (edge === null || typeof edge !== "object" || Array.isArray(edge)) {
          return edge;
        }
        const e = edge as { readonly ether?: unknown; readonly [k: string]: unknown };
        const etherIn = e.ether;
        if (
          etherIn === null ||
          typeof etherIn !== "object" ||
          Array.isArray(etherIn)
        ) {
          return edge;
        }
        const eth = etherIn as Record<string, unknown>;
        const rawStops = eth.stops ?? eth.criteria;
        // Retire authorable proof/approval gates — product stoppage is derived.
        const stops =
          rawStops !== null &&
          typeof rawStops === "object" &&
          !Array.isArray(rawStops) &&
          ((rawStops as { readonly mode?: unknown }).mode === "proof" ||
            (rawStops as { readonly mode?: unknown }).mode === "approval")
            ? undefined
            : rawStops;
        const doesRaw = eth.does ?? eth.effect;
        const does =
          doesRaw !== undefined ? scrubDoesEffect(doesRaw) : undefined;
        const wake = eth.wake ?? eth.notify;
        const next: Record<string, unknown> = {};
        if (eth.ports !== undefined) next.ports = eth.ports;
        if (stops !== undefined) next.stops = stops;
        if (wake !== undefined) next.wake = wake;
        if (eth.slot !== undefined) next.slot = eth.slot;
        if (eth.when !== undefined) next.when = eth.when;
        if (does !== undefined) next.does = does;
        if (eth.kind !== undefined) next.kind = eth.kind;
        // Drop: criteria, effect, notify, relayState, proof/approval stops, dual keys.
        if (Object.keys(next).length === 0) {
          const { ether: _e, ...rest } = e;
          return rest;
        }
        return { ...e, ether: next };
      })
    : raw.edges;
  return { ...raw, nodes, edges };
};

export const decodeCanvasDoc = (
  input: unknown,
): ReturnType<typeof decodeCanvasDocStrict> =>
  decodeCanvasDocStrict(scrubCanvasDocInput(input));

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

// Project derived phase onto stops edges only. Never stamp labels (product:
// no phase words on the canvas). Blocks demotion clears mirror color "1".
export const applyPhaseMirror = (
  doc: CanvasDoc,
  phaseByEdgeId: ReadonlyMap<string, EdgePhase>,
): CanvasDoc => ({
  nodes: doc.nodes,
  edges: doc.edges.map((edge) => {
    const ether = edge.ether;
    if (ether === undefined || !edgeStops(ether)) return edge;
    const phase = phaseByEdgeId.get(edge.id);
    if (phase === undefined) return edge;
    const base = {
      ...edge,
      ether: {
        ...ether,
        kind: phase,
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
