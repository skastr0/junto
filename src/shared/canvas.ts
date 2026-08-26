import { Schema } from "effect";
import { HarnessId } from "./managed-terminal-templates";
import {
  compileVerb,
  inferVerb,
  VERBS,
  Verb,
  verbsForPair,
  type LegacyEdgeEther,
  type VerbGrant,
} from "./physics/verbs";
import {
  ClaimDef,
  EtherArtifacts,
  EtherBoard,
  EtherMessages,
  EtherPad,
  EtherRequests,
  EtherTasks,
  Ruling,
} from "./work-model";

export {
  Artifact,
  BoardAuthor,
  BoardGlanceTopic,
  BoardPost,
  BoardTopic,
  CheckDef,
  ClaimDef,
  ClaimResponse,
  ClaimSeverity,
  ClaimWaiver,
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
  Passage,
  PassageExit,
  RawPart,
  resolveSinkAdmission,
  Ruling,
  SinkAdmission,
  Task,
  TaskClaim,
  TaskProposal,
  TaskState,
  TasksInboundContract,
  TasksOutboundContract,
  TasksSinkContract,
  TextPart,
  Ticket,
  TicketSide,
  TICKET_OUTPUT_TAIL_MAX_BYTES,
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

// Live edge phase — DERIVED from work state (claimed attention on a task or
// requests sink). Never authorial and never stored: the document carries the
// relationship (`ether.verb`); evaluation produces phase.
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
  "terminal",
  "page",
  "watcher",
  "timer",
  "cron",
  "relay",
  // Geography furniture: bare map text. Not a physics KindSpecs key — role
  // stays geography via open-vocab resolveSpec (same as notes / unknown kinds).
  "label",
  // Commit browser. Visualization only — no ports, no wires. Role stays
  // geography via open-vocab resolveSpec (same as label).
  "git",
] as const;

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

/** Authorial binding for entity.kind === "git". Live status is never stored here. */
export const EtherGit = Schema.Struct({
  cwd: Schema.String,
});
export type EtherGit = typeof EtherGit.Type;

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

// Authorial host stamp for executable nodes (agent, page, watcher, timer).
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
// Page stamps start url + browser profile + physical host (cookies stay runtime).
// Paths stamp actor cwd (agent/terminal) keyed by host — different machines
// often need different absolute paths for the same logical project.
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
  page: Schema.optionalKey(EtherRegionPageDefaults),
  /** Per-host default working directory for agents/terminals created inside. */
  paths: Schema.optionalKey(EtherRegionPaths),
});
export type EtherRegionDefaults = typeof EtherRegionDefaults.Type;

// Operator-authored region standing law. Claims stack onto every task closing
// at a sink inside the region (outer → inner across the region stack);
// rulings are pinned escalation precedents served via onboard / claim packet.
// Seats have no authorial write path to this contract.
export const EtherRegionContract = Schema.Struct({
  claims: Schema.optionalKey(Schema.Array(ClaimDef)),
  rulings: Schema.optionalKey(Schema.Array(Ruling)),
});
export type EtherRegionContract = typeof EtherRegionContract.Type;

// Region behavior (group nodes only). `hold: true` makes the region a
// structural container: nodes spatially inside it travel with it when it
// moves. `instruction` is optional operator briefing text for agents inside
// the region — surfaced on work-control `onboard` (not auto-injected).
// Membership itself is always DERIVED from geometry at interaction time —
// never stored — so the document cannot go incoherent.
// `defaults` is a create-time stamp source for page/path bags on nodes placed
// inside the region. Page bags are bag-atomic (innermost region with a bag for
// that kind wins). Paths are host-keyed: innermost region that
// defines a path for the spawn host wins; missing hosts walk outward.
export const EtherRegion = Schema.Struct({
  hold: Schema.optionalKey(Schema.Boolean),
  instruction: Schema.optionalKey(Schema.String),
  defaults: Schema.optionalKey(EtherRegionDefaults),
  contract: Schema.optionalKey(EtherRegionContract),
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

// Watch predicates (`WatchWhen`) and fire actions (`EdgeEffect`) are compiled
// facets of a verb and live in physics/verbs.ts. The document never carries
// them, so they are not part of this schema.

// Work read plane — normalized WorkService rows are projected into these
// fields for renderer/kernel consumers. They remain part of the composed
// CanvasDoc shape, but authorial persistence and Station portfolio boundaries
// reject them. Old checklist {id,text,done} is dead and fails decode.

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
  /** Repo path for entity.kind === "git". Live branch/diff is IPC, not document. */
  git: Schema.optionalKey(EtherGit),
  // Host that may execute/tool this node. Optional for graceful degradation.
  host: Schema.optionalKey(EtherHostId),
});
export type EtherNodeExtension = typeof EtherNodeExtension.Type;

/**
 * The one authored fact on an edge: what the relationship **is**.
 *
 * Ports, assignability, board wake, watch predicates, fire actions, pipeline
 * flow, and scheduler chaining are compiled from the verb plus the two endpoint
 * kinds (`physics/verbs.ts`) — never stored, never mirrored. `fromNode` is
 * always the verb's source end, whichever way the operator dragged.
 */
export const EtherEdgeExtension = Schema.Struct({
  verb: Verb,
});
export type EtherEdgeExtension = typeof EtherEdgeExtension.Type;

export const edgeVerb = (
  ether: EtherEdgeExtension | undefined,
): Verb | undefined => ether?.verb;

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

/**
 * Node id → authored entity kind. Groups are omitted: a region is geography
 * whatever kind word it carries, and geography holds no verb.
 *
 * Build once per pass and hand it to `compileEdgeGrant` — compiling a verb
 * needs both endpoint kinds, and rescanning `doc.nodes` per edge is quadratic.
 */
export const edgeKindIndex = (doc: CanvasDoc): ReadonlyMap<string, string> => {
  const kinds = new Map<string, string>();
  for (const node of doc.nodes) {
    if (node.type === "group") continue;
    const kind = node.ether?.entity?.kind;
    // First node wins on a duplicated id, the same rule every `doc.nodes.find`
    // consumer already follows.
    if (kind !== undefined && !kinds.has(node.id)) kinds.set(node.id, kind);
  }
  return kinds;
};

/**
 * What this edge grants, compiled from its verb and the two endpoint kinds.
 * `undefined` when the edge carries no verb or the pair cannot hold it.
 */
export const compileEdgeGrant = (
  edge: CanvasEdge,
  kinds: ReadonlyMap<string, string>,
): VerbGrant | undefined => {
  const verb = edge.ether?.verb;
  if (verb === undefined) return undefined;
  return compileVerb(verb, kinds.get(edge.fromNode), kinds.get(edge.toNode));
};

/** One-off compile. Loops over edges should hoist `edgeKindIndex` instead. */
export const edgeGrant = (
  doc: CanvasDoc,
  edge: CanvasEdge,
): VerbGrant | undefined => compileEdgeGrant(edge, edgeKindIndex(doc));

const decodeCanvasDocStrict = Schema.decodeUnknownResult(CanvasDoc, {
  onExcessProperty: "error",
});
export const encodeCanvasDoc = Schema.encodeResult(CanvasDoc);

const WORK_PROJECTION_KEYS = [
  "requests",
  "messages",
  "artifacts",
  "board",
  "pad",
] as const;

const isNonEmptyArrayField = (value: unknown, key: string): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) && field.length > 0;
};

/**
 * Runtime work projections share CanvasDoc with authorial intent so composed
 * readers have one shape. Persistence boundaries use this detector before
 * decode because a valid projected store must never become durable intent.
 * `ether.tasks` is special: its `contract` is operator-authored document
 * truth, so only projected rows (items/proposals) make it a work projection.
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
    if (
      WORK_PROJECTION_KEYS.some((key) =>
        Object.prototype.hasOwnProperty.call(ether, key),
      )
    ) {
      return true;
    }
    const tasks = (ether as { readonly tasks?: unknown }).tasks;
    return (
      isNonEmptyArrayField(tasks, "items") ||
      isNonEmptyArrayField(tasks, "proposals")
    );
  });
};

/** Node id → entity kind, read straight off raw input (pre-decode). */
const rawKindIndex = (nodes: unknown): ReadonlyMap<string, string> => {
  const kinds = new Map<string, string>();
  if (!Array.isArray(nodes)) return kinds;
  for (const node of nodes) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      continue;
    }
    const n = node as Record<string, unknown>;
    const id = n.id;
    // A group is geography whatever kind it names, so it never indexes.
    if (typeof id !== "string" || n.type === "group") continue;
    const ether = n.ether;
    if (ether === null || typeof ether !== "object" || Array.isArray(ether)) {
      continue;
    }
    const entity = (ether as Record<string, unknown>).entity;
    if (entity === null || typeof entity !== "object" || Array.isArray(entity)) {
      continue;
    }
    const kind = (entity as Record<string, unknown>).kind;
    // First node wins on a duplicated id (see `edgeKindIndex`).
    if (typeof kind === "string" && !kinds.has(id)) kinds.set(id, kind);
  }
  return kinds;
};

const asStringArray = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;

const asFlowConfig = (
  value: unknown,
): { readonly source?: string; readonly destination?: string } | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const flow = value as Record<string, unknown>;
  const source = flow.source;
  const destination = flow.destination;
  return {
    ...(typeof source === "string" ? { source } : {}),
    ...(typeof destination === "string" ? { destination } : {}),
  };
};

/** The wire areas an edge used to carry, with the old dual keys collapsed. */
const readLegacyEdgeEther = (eth: Record<string, unknown>): LegacyEdgeEther => {
  const wake = eth.wake ?? eth.notify;
  return {
    ports: asStringArray(eth.ports),
    wake: typeof wake === "boolean" ? wake : undefined,
    slot: typeof eth.slot === "string" ? eth.slot : undefined,
    when: eth.when,
    does: eth.does ?? eth.effect,
    flow: asFlowConfig(eth.flow),
  };
};

const isVerb = (value: unknown): value is Verb =>
  typeof value === "string" && (VERBS as ReadonlyArray<string>).includes(value);

const pairHolds = (
  verb: Verb,
  fromKind: string | undefined,
  toKind: string | undefined,
): boolean =>
  verbsForPair(fromKind, toKind).includes(verb) ||
  verbsForPair(toKind, fromKind).includes(verb);

/**
 * Collapse old dual-keys, delete dead node bodies, and convert every edge to
 * its semantic verb before strict decode.
 *
 * The edge conversion is one-shot and terminal: legacy wire areas (ports,
 * stops, wake, slot, when, does, flow, and the phase mirror) are read once to
 * name the verb the edge always meant, then dropped forever. An already-verbed
 * edge keeps its authored verb — re-inference would silently widen a narrow
 * choice (`messages` back into `participates`) on every load. An edge whose
 * endpoints cannot hold a verb — geography, an unknown kind, a missing node,
 * a pairing the grammar never admitted — does not survive the pass.
 *
 * Surviving edges are stored in the verb's own order: `fromNode` is the verb's
 * source end, with side and end metadata carried across the swap.
 *
 * Node-body `ether.relay` is not a product surface — watch is a compiled facet
 * of a verb, never a node field.
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
  const kindById = rawKindIndex(raw.nodes);
  const edges = Array.isArray(raw.edges)
    ? raw.edges.flatMap((edge) => {
        if (edge === null || typeof edge !== "object" || Array.isArray(edge)) {
          // Not an edge shape at all — leave it for strict decode to reject.
          return [edge];
        }
        const {
          ether: etherIn,
          fromNode,
          toNode,
          fromSide,
          toSide,
          fromEnd,
          toEnd,
          ...rest
        } = edge as Record<string, unknown>;
        if (typeof fromNode !== "string" || typeof toNode !== "string") {
          return [edge];
        }
        const fromKind = kindById.get(fromNode);
        const toKind = kindById.get(toNode);
        const eth =
          etherIn !== null &&
          typeof etherIn === "object" &&
          !Array.isArray(etherIn)
            ? (etherIn as Record<string, unknown>)
            : undefined;
        const authored = eth?.verb;
        const verb =
          isVerb(authored) && pairHolds(authored, fromKind, toKind)
            ? authored
            : inferVerb(
                eth === undefined ? undefined : readLegacyEdgeEther(eth),
                fromKind,
                toKind,
              );
        if (verb === undefined) return [];
        // Store in the verb's own order. A pair that reads both ways keeps the
        // drawn order, except a legacy flow config, which named its direction.
        const legacyFlow = eth === undefined ? undefined : asFlowConfig(eth.flow);
        const swap =
          verb === "feeds" && legacyFlow?.source === toNode
            ? true
            : !verbsForPair(fromKind, toKind).includes(verb);
        const next: Record<string, unknown> = { ...rest };
        next.fromNode = swap ? toNode : fromNode;
        next.toNode = swap ? fromNode : toNode;
        const nextFromSide = swap ? toSide : fromSide;
        const nextToSide = swap ? fromSide : toSide;
        const nextFromEnd = swap ? toEnd : fromEnd;
        const nextToEnd = swap ? fromEnd : toEnd;
        if (nextFromSide !== undefined) next.fromSide = nextFromSide;
        if (nextToSide !== undefined) next.toSide = nextToSide;
        if (nextFromEnd !== undefined) next.fromEnd = nextFromEnd;
        if (nextToEnd !== undefined) next.toEnd = nextToEnd;
        next.ether = { verb };
        return [next];
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
// readers. Applied on every save. Nodes only: a blocker flag mirrors to crimson
// `color`. Edges carry no derived phase — an edge says what the relationship
// is, and phase is recomputed from live work state at read time, so there is
// nothing on an edge left to mirror.
export const applyMirrorLaw = (doc: CanvasDoc): CanvasDoc => ({
  nodes: doc.nodes.map((node) =>
    node.ether?.flags?.includes("blocker") ? { ...node, color: "1" } : node,
  ),
  edges: doc.edges,
});
