// Frozen for the inert Station; removed when Stations are rebuilt.
// Copied from shared/canvas.ts. No product store or model service is read here.
import { Schema } from "effect";
import { HarnessId } from "@shared/managed-terminal-templates";
import { ActorSeatId } from "@shared/actor-seat";
import { ActorRef, TaskRef } from "@shared/work-reference";
import { ContentPart } from "@shared/content";
import { ReviewVerdict } from "@shared/crew";
import { Port } from "@shared/physics/schema";
import {
  compileVerb,
  inferVerb,
  VERBS,
  Verb,
  verbsForPair,
  type LegacyEdgeEther,
  type VerbGrant,
} from "@shared/physics/verbs";
// Historical node-body schemas copied verbatim from shared/work-model.ts and
// shared/sheet.ts. The inert Station must not keep retired product types alive.
/**
 * Durable work-domain contracts.
 *
 * These schemas define the values stored in normalized SQLite work rows and
 * assembled into runtime projections. Storage location and single-home
 * routing remain repository concerns rather than fields on each component.
 */

export const TextPart = Schema.Struct({
  kind: Schema.Literal("text"),
  text: Schema.String,
});
export type TextPart = typeof TextPart.Type;

export const UrlPart = Schema.Struct({
  kind: Schema.Literal("url"),
  url: Schema.String,
  mediaType: Schema.optionalKey(Schema.String),
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
  mediaType: Schema.optionalKey(Schema.String),
});
export type RawPart = typeof RawPart.Type;

export const Part = Schema.Union([TextPart,
UrlPart,
DataPart,
RawPart,
ContentPart,]);
export type Part = typeof Part.Type;

export const MessageRole = Schema.Literals(["user", "agent"]);
export type MessageRole = typeof MessageRole.Type;

/**
 * A2A-compatible extension values. The record is a typed field on each
 * domain object; repositories must not replace the object itself with an
 * opaque payload column.
 */
export const WorkMetadata = Schema.Record(Schema.String, Schema.Unknown);
export type WorkMetadata = typeof WorkMetadata.Type;

export const Message = Schema.Struct({
  messageId: Schema.String,
  role: MessageRole,
  parts: Schema.Array(Part),
  taskId: Schema.optionalKey(Schema.String),
  contextId: Schema.optionalKey(Schema.String),
  referenceTaskIds: Schema.optionalKey(Schema.Array(Schema.String)),
  metadata: Schema.optionalKey(WorkMetadata),
});
export type Message = typeof Message.Type;

/**
 * Work task states. `auth-required` is residual durable-only: no producer may
 * enter it; decode + heal exits remain for installed rows and event history.
 * Operator escalation is `input-required` or a request.
 *
 * `archived` is operator soft-delete: durable row remains, but board/CLI
 * projections omit it so the task disappears from the sink surface (unlike
 * canceled/rejected/completed which stay in Closed).
 */
export const TaskState = Schema.Literals(["submitted", "working",
"input-required",
"completed",
"canceled",
"failed",
"rejected",
"auth-required",
"archived",]);
export type TaskState = typeof TaskState.Type;

/**
 * Operator-authored done-definition. Optional whole object.
 * Nested presence of artifacts/git arms the corresponding hard gate.
 */
export const FinishCriteria = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  artifacts: Schema.optionalKey(Schema.Struct({
    /** Artifacts sink node id (same canvas ambient). */
    nodeId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    instruction: Schema.optionalKey(Schema.String),
    /** When set, every name must match an evidence artifact.name exactly. */
    names: Schema.optionalKey(Schema.Array(Schema.String)),
  })),
  git: Schema.optionalKey(Schema.Struct({
    minCommits: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  })),
});
export type FinishCriteria = typeof FinishCriteria.Type;

// ---- Task rules, claims, checks, and visits ----

const ruleFields = {
  /** ULID minted at authoring. */
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** Omitted is a prose statement; review rules also arm an independent gate. */
  kind: Schema.optionalKey(Schema.Literals(["statement", "requires-review"])),
} as const;

/**
 * An operator-authored statement the work must satisfy. The work service
 * enforces that an agent makes a claim for every rule, never that it is true.
 */
export const Rule = Schema.Struct(ruleFields);
export type Rule = typeof Rule.Type;

/** Operator-pinned precedent, appended when an escalation/request resolves. */
export const Ruling = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** ISO timestamp. */
  pinnedAt: Schema.String,
  sourceRequestId: Schema.optionalKey(Schema.String),
});
export type Ruling = typeof Ruling.Type;

/**
 * Deterministic check. The agent's CLI executes `command` in its own
 * environment; exit 0 passes.
 */
export const Check = Schema.Struct({
  /** ULID minted at authoring. */
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  label: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  command: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type Check = typeof Check.Type;

/** A task-authored rule addressed to one board on its path. */
export const TaskRule = Schema.Struct({
  ...ruleFields,
  /** Tasks node id where this rule must be answered or fork-waived. */
  board: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type TaskRule = typeof TaskRule.Type;

/** Who may start a submitted task. Omitted = "auto". */
export const TaskAdmission = Schema.Literals(["auto", "approval", "operator"]);
export type TaskAdmission = typeof TaskAdmission.Type;

export const TasksIncoming = Schema.Struct({
  /** How new tasks should be handled here. */
  handling: Schema.optionalKey(Schema.String),
  /** Prose self-description for earlier boards choosing a path. */
  description: Schema.optionalKey(Schema.String),
  admission: Schema.optionalKey(TaskAdmission),
  /** Board default delay before a task can be claimed. */
  waitMs: Schema.optionalKey(
    Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  checks: Schema.optionalKey(Schema.Array(Check)),
});
export type TasksIncoming = typeof TasksIncoming.Type;

export const TasksOutgoing = Schema.Struct({
  /** What the agent must write in the handoff note when sending work onward. */
  handoff: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(Schema.Array(Check)),
});
export type TasksOutgoing = typeof TasksOutgoing.Type;

/**
 * Operator-authored board contract (`ether.tasks.contract`). Agents have no
 * authorial write path to it.
 */
export const TasksContract = Schema.Struct({
  /** Prose agents read when they claim a task here. */
  instructions: Schema.optionalKey(Schema.String),
  rules: Schema.optionalKey(Schema.Array(Rule)),
  incoming: Schema.optionalKey(TasksIncoming),
  outgoing: Schema.optionalKey(TasksOutgoing),
});
export type TasksContract = typeof TasksContract.Type;

/** An agent's answer to one rule, recorded at completion. */
export const Claim = Schema.Struct({
  ruleId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  refs: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type Claim = typeof Claim.Type;

/** A fork waiver for a task rule whose board is no longer reachable. */
export const Waiver = Schema.Struct({
  ruleId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  reason: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type Waiver = typeof Waiver.Type;

/**
 * Agent-supplied proof at complete. Artifacts are explicit citations (no
 * auto-append on publish). Git is expandable (commits first; later repo, etc.).
 * Claims and waivers answer the rules in force for this completion.
 */
export const CompletionEvidence = Schema.Struct({
  artifacts: Schema.Array(
    Schema.Struct({
      artifactId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
      nodeId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    }),
  ),
  git: Schema.optionalKey(Schema.Struct({
    commits: Schema.Array(Schema.String),
  })),
  claims: Schema.optionalKey(Schema.Array(Claim)),
  waivers: Schema.optionalKey(Schema.Array(Waiver)),
});
export type CompletionEvidence = typeof CompletionEvidence.Type;

/** How a visit ended. */
export const VisitExit = Schema.Literals(["sent-on", "completed", "sent-back"]);
export type VisitExit = typeof VisitExit.Type;

/** One board a task has entered. Append-only. */
export const Visit = Schema.Struct({
  board: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  enteredAt: Schema.String,
  epoch: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  claimedBy: Schema.optionalKey(ActorSeatId),
  exitedAt: Schema.optionalKey(Schema.String),
  exit: Schema.optionalKey(VisitExit),
  /** Destination Tasks node id chosen when sent on. */
  next: Schema.optionalKey(Schema.String),
  handoffNote: Schema.optionalKey(Schema.String),
});
export type Visit = typeof Visit.Type;

/**
 * Append-only defect record: epoch `epoch` was opened by a defect aimed at
 * board `target`. Claims made before the defect at boards strictly
 * upstream of `target` stay live for closure accounting; receipts at or
 * downstream of `target` are shadowed. Waivers never survive any defect.
 * Nothing ever mutates or removes an entry — liveness is derived, not stored.
 */
export const TaskDefect = Schema.Struct({
  epoch: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  /** Tasks node id of the visited board the task was sent back to. */
  target: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** ISO timestamp of the defect. */
  at: Schema.String,
});
export type TaskDefect = typeof TaskDefect.Type;

/** Check output tail cap (the check op handler truncates by bytes). */
export const CHECK_OUTPUT_TAIL_MAX_BYTES = 8 * 1024;

export const CheckSide = Schema.Literals(["outgoing", "incoming"]);
export type CheckSide = typeof CheckSide.Type;

/**
 * System-stamped check result. Written only by the `tasks.check` op handler
 * from agent-submitted runs, never accepted from completion evidence.
 */
export const CheckResult = Schema.Struct({
  checkId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  side: CheckSide,
  command: Schema.String,
  exitCode: Schema.Number.pipe(Schema.check(Schema.isInt())),
  outputTail: Schema.String.pipe(Schema.check(Schema.isMaxLength(CHECK_OUTPUT_TAIL_MAX_BYTES))),
  /** ISO timestamp. */
  at: Schema.String,
  epoch: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type CheckResult = typeof CheckResult.Type;

/**
 * Shared immutable task-authoring fields. Brief and media live on
 * `Task.history[0].parts`.
 */
export const TaskAuthoringFields = {
  /**
   * Same-board prerequisites (task ids). Empty / omitted = free to claim when
   * submitted and admitted. Join is ALL; only `completed` satisfies.
   */
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Operator done-definition; immutable on generic task transition. */
  finishCriteria: Schema.optionalKey(FinishCriteria),
  /** Board-addressed rules; set at creation, immutable on generic transitions. */
  rules: Schema.optionalKey(Schema.Array(TaskRule)),
  metadata: Schema.optionalKey(WorkMetadata),
  /** Why the raiser raised this (first-class, set at creation). */
  reason: Schema.optionalKey(Schema.String),
} as const;

export const Task = Schema.Struct({
  id: Schema.String,
  state: TaskState,
  /**
   * First-class claimant identity. Claim is domain state, never an opaque
   * metadata convention.
   */
  claimedBy: Schema.optionalKey(ActorSeatId),
  history: Schema.Array(Message),
  artifactIds: Schema.optionalKey(Schema.Array(Schema.String)),
  dependsOn: TaskAuthoringFields.dependsOn,
  finishCriteria: TaskAuthoringFields.finishCriteria,
  rules: TaskAuthoringFields.rules,
  /** Stamped only on successful → completed. */
  completionEvidence: Schema.optionalKey(CompletionEvidence),
  /** Defect generation counter. Staleness is derived from the defects log: a defect shadows receipts at and downstream of its target. Default 0. */
  epoch: Schema.optionalKey(
    Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  /** Append-only record of boards entered. */
  visits: Schema.optionalKey(Schema.Array(Visit)),
  /** Append-only defect log; claim liveness is derived, never stored. */
  defects: Schema.optionalKey(Schema.Array(TaskDefect)),
  /** Not claimable before this ISO time. */
  waitUntil: Schema.optionalKey(Schema.String),
  /** Current-epoch check results, stamped only by the check operation. */
  checkResults: Schema.optionalKey(Schema.Array(CheckResult)),
  metadata: TaskAuthoringFields.metadata,
  reason: TaskAuthoringFields.reason,
  /**
   * Requester admission overlay. Omitted = inherit the sink floor
   * (`resolveTaskAdmission`, default auto). Agents persist an explicit
   * `approval` stamp when omitted on the wire. Never loosens the board floor.
   */
  admission: Schema.optionalKey(TaskAdmission),
  /** Who raised this task. Optional; historical rows omit it. */
  raisedBy: Schema.optionalKey(ActorRef),
  /** The operator's answer (first-class, stamped on resolve). */
  response: Schema.optionalKey(Schema.String),
  /** Projection of the immutable verdict chain for this exact task identity. */
  verdicts: Schema.optionalKey(Schema.Array(ReviewVerdict)),
  /** Projection recomputed from the current task epoch and exact evidence refs. */
  subjectHash: Schema.optionalKey(Schema.String),
  /**
   * Projection: when this task or request entered its current state (ISO),
   * the origin time of the fact that changed it. Stamped by the work
   * repository on every item it projects; never authored, and never part of
   * a fact body.
   */
  stateSince: Schema.optionalKey(Schema.String),
}).pipe(
  Schema.check(Schema.makeFilter(({ id, state, claimedBy, metadata, dependsOn, completionEvidence }) => {
    if (
      metadata !== undefined &&
      Object.prototype.hasOwnProperty.call(metadata, "claimedBy")
    ) {
      return "metadata.claimedBy is retired; use Task.claimedBy";
    }
    if (state === "submitted" && claimedBy !== undefined) {
      return "submitted tasks must be unclaimed";
    }
    if (
      (state === "working" ||
        state === "input-required" ||
        state === "auth-required") &&
      claimedBy === undefined
    ) {
      return `${state} tasks require claimedBy`;
    }
    if (
      completionEvidence !== undefined &&
      state !== "completed" &&
      state !== "working"
    ) {
      return "completionEvidence is only valid on completed or working tasks (staged review evidence)";
    }
    if (dependsOn !== undefined) {
      const seen = new Set<string>();
      for (const dep of dependsOn) {
        if (typeof dep !== "string" || dep.trim().length === 0) {
          return "dependsOn entries must be non-empty task ids";
        }
        if (dep === id) return "dependsOn cannot include the task itself";
        if (seen.has(dep)) return "dependsOn must not contain duplicates";
        seen.add(dep);
      }
    }
    return true;
  })),
);
export type Task = typeof Task.Type;

export const Artifact = Schema.Struct({
  artifactId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  parts: Schema.Array(Part),
  task: Schema.optionalKey(TaskRef),
  metadata: Schema.optionalKey(WorkMetadata),
});
export type Artifact = typeof Artifact.Type;

/**
 * Tasks node contents. `name` and `contract` are operator-authored document
 * truth; items are the runtime Work projection.
 */
export const WorkTasks = Schema.Struct({
  items: Schema.Array(Task),
  name: Schema.optionalKey(Schema.String),
  contract: Schema.optionalKey(TasksContract),
});
export type WorkTasks = typeof WorkTasks.Type;

/**
 * Requests sink contents. Requests share the Task state machine. `name` is
 * operator-authored document truth (the sink's stable identity, surviving
 * work ops); items are the runtime Work projection.
 */
export const WorkRequests = Schema.Struct({
  items: Schema.Array(Task),
  name: Schema.optionalKey(Schema.String),
});
export type WorkRequests = typeof WorkRequests.Type;

/** Artifact sink contents. */
export const WorkArtifacts = Schema.Struct({
  items: Schema.Array(Artifact),
});
export type WorkArtifacts = typeof WorkArtifacts.Type;

export const BoardTopicState = Schema.Literals(["open", "archived"]);
export type BoardTopicState = typeof BoardTopicState.Type;

/**
 * Canvas glance strip — titles + counts only. Full posts stay on list/detail.
 */
export const BoardGlanceTopic = Schema.Struct({
  topicId: Schema.String,
  title: Schema.String,
  state: BoardTopicState,
  postCount: Schema.Number,
  lastActivityAt: Schema.String,
  authorLabel: Schema.optionalKey(Schema.String),
  /** Operator's unread posts on this topic (own posts never count). */
  unreadPostCount: Schema.optionalKey(Schema.Number),
});
export type BoardGlanceTopic = typeof BoardGlanceTopic.Type;

export const EtherBoard = Schema.Struct({
  topics: Schema.Array(BoardGlanceTopic),
  /** Operator-local unread post count when known (sum over topics). */
  unread: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
});
export type EtherBoard = typeof EtherBoard.Type;

/** Canvas glance strip — title lives on the text node; counts from SQLite. */
export const PadGlance = Schema.Struct({
  revision: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  shapeCount: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  unreadPinCount: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
export type PadGlance = typeof PadGlance.Type;

/**
 * Canonical work-lane values exposed at the runtime projection boundary.
 * These names identify projected lane contents; they are not document
 * durability or a second persistence model.
 */
export const EtherTasks = WorkTasks;
export type EtherTasks = WorkTasks;

export const EtherRequests = WorkRequests;
export type EtherRequests = WorkRequests;

export const EtherArtifacts = WorkArtifacts;
export type EtherArtifacts = WorkArtifacts;

export const SHEET_MAX_COLUMNS = 32;
export const SHEET_MAX_ROWS = 500;
export const SHEET_MAX_CELL_LENGTH = 2_000;
export const SHEET_MAX_NAME_LENGTH = 120;
/** Editor row pitch — keep in lockstep with `.junto-sheet__grid` CSS. */
export const SHEET_ROW_HEIGHT_PX = 32;
export const SHEET_ROW_OVERSCAN = 10;

const Identifier = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
);

export const SheetColumn = Schema.Struct({
  id: Identifier,
  name: Schema.String.pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_NAME_LENGTH))),
});
export type SheetColumn = typeof SheetColumn.Type;

export const SheetRow = Schema.Struct({
  id: Identifier,
  /** Column id → cell text. A missing key is an empty cell. */
  cells: Schema.Record(
    Schema.String,
    Schema.String.pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_CELL_LENGTH))),
  ),
});
export type SheetRow = typeof SheetRow.Type;

export const EtherSheet = Schema.Struct({
  columns: Schema.Array(SheetColumn).pipe(
    Schema.check(Schema.isMaxLength(SHEET_MAX_COLUMNS)),
  ),
  rows: Schema.Array(SheetRow).pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_ROWS))),
});
export type EtherSheet = typeof EtherSheet.Type;


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
  "sheet",
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

// Bound Junto-owned terminal work surface (flat session binding).
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
  /**
   * Operator-authored harness arguments beyond the picker dials. Already part
   * of `argv`; kept here as well so every replanned spawn and resume appends
   * the same tokens (see `shared/launch-extra-args.ts`).
   */
  extraArgs: Schema.optionalKey(Schema.Array(Schema.String)),
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
// cookies live in ~/.junto/browser (runtime), never in the canvas document.
// Native JSON Canvas type remains `link` (url); kind "page" + ether.browser
// upgrade the node to an in-app session binding. onDelete default is
// kill-session: deleting the page node closes the Junto-owned session for
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

// Operator-authored region rules. Rules stack onto every task closing at a
// board inside the region (outer → inner across the region stack); rulings are
// pinned escalation precedents served via onboard and task rules. Agents have
// no authorial write path to this contract.
export const EtherRegionContract = Schema.Struct({
  rules: Schema.optionalKey(Schema.Array(Rule)),
  rulings: Schema.optionalKey(Schema.Array(Ruling)),
});
export type EtherRegionContract = typeof EtherRegionContract.Type;

// Region environment: what seats inside a region are launched with. The
// document holds NAMES AND REFERENCES ONLY: where a value lives on this
// machine (a Keychain item, a 1Password reference, a file), never the value.
// The one exception is `kind: "value"`, a plain non-secret setting the
// operator typed. Read live at every spawn and resume, never stamped onto
// nodes: see shared/region-environment.ts for the resolution law.
const EnvSourceBase = {
  /** Stable handle within the region: reports, tokenFrom and edits key on it. */
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** A source that cannot be read refuses the launch instead of being left out. */
  required: Schema.optionalKey(Schema.Boolean),
  /** Applies only on this machine. Absent means every machine. */
  host: Schema.optionalKey(EtherHostId),
} as const;

/** A variable name a process environment accepts. */
const EnvName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
);
const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

export const EnvSource = Schema.Union([
  /** A plain value. NOT secret: it is stored in the document as written. */
  Schema.Struct({
    ...EnvSourceBase,
    kind: Schema.Literal("value"),
    name: EnvName,
    value: Schema.String,
  }),
  /** A secret held in Junto's own secret store, by id. */
  Schema.Struct({
    ...EnvSourceBase,
    kind: Schema.Literal("secret"),
    name: EnvName,
    secretId: NonEmpty,
  }),
  /** An item that already exists in the macOS Keychain, read in place. */
  Schema.Struct({
    ...EnvSourceBase,
    kind: Schema.Literal("keychain"),
    name: EnvName,
    service: NonEmpty,
    account: Schema.optionalKey(Schema.String),
  }),
  /** An item that already exists in the Linux Secret Service, read in place. */
  Schema.Struct({
    ...EnvSourceBase,
    kind: Schema.Literal("keyring"),
    name: EnvName,
    attributes: Schema.Record(Schema.String, Schema.String),
  }),
  /**
   * A 1Password reference (`op://vault/item/field`). `tokenFrom` is the id of
   * another source in scope that yields the service-account token.
   */
  Schema.Struct({
    ...EnvSourceBase,
    kind: Schema.Literal("onepassword"),
    name: EnvName,
    ref: NonEmpty,
    tokenFrom: Schema.optionalKey(NonEmpty),
  }),
  /** A dotenv file: every name it defines. */
  Schema.Struct({
    ...EnvSourceBase,
    kind: Schema.Literal("envFile"),
    path: NonEmpty,
  }),
  /** A directory with one file per variable. */
  Schema.Struct({
    ...EnvSourceBase,
    kind: Schema.Literal("secretsDir"),
    path: NonEmpty,
    prefix: Schema.optionalKey(Schema.String),
  }),
  /** Escape hatch: the command's stdout is the value. */
  Schema.Struct({
    ...EnvSourceBase,
    kind: Schema.Literal("command"),
    name: EnvName,
    argv: Schema.Array(Schema.String).pipe(Schema.check(Schema.isMinLength(1))),
  }),
]);
export type EnvSource = typeof EnvSource.Type;
export type EnvSourceKind = EnvSource["kind"];

export const EtherRegionEnvironment = Schema.Struct({
  /** Seats inside inherit nothing from regions outside this one. */
  sealed: Schema.optionalKey(Schema.Boolean),
  /** Applied in list order; a later source overrides an earlier one by name. */
  sources: Schema.optionalKey(Schema.Array(EnvSource)),
  /** Extra directories exposed to seats inside (absolute or `~/` paths). */
  folders: Schema.optionalKey(Schema.Array(NonEmpty)),
});
export type EtherRegionEnvironment = typeof EtherRegionEnvironment.Type;

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
// `environment` is the opposite of a stamp: it is read live at every spawn of
// a seat inside the region.
export const EtherRegion = Schema.Struct({
  hold: Schema.optionalKey(Schema.Boolean),
  instruction: Schema.optionalKey(Schema.String),
  defaults: Schema.optionalKey(EtherRegionDefaults),
  contract: Schema.optionalKey(EtherRegionContract),
  environment: Schema.optionalKey(EtherRegionEnvironment),
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
// reject them.

export const EtherNodeExtension = Schema.Struct({
  entity: Schema.optionalKey(EtherEntity),
  /** Human-granted administrative authority for an executable agent seat. */
  overseer: Schema.optionalKey(Schema.Boolean),
  region: Schema.optionalKey(EtherRegion),
  watch: Schema.optionalKey(EtherWatch),
  timer: Schema.optionalKey(EtherTimer),
  tasks: Schema.optionalKey(EtherTasks),
  requests: Schema.optionalKey(EtherRequests),
  artifacts: Schema.optionalKey(EtherArtifacts),
  /** Runtime overlay for entity.kind === "board" (glance only; SQLite owns truth). */
  board: Schema.optionalKey(EtherBoard),
  /** Runtime overlay for entity.kind === "pad" (glance only; SQLite owns truth). */
  pad: Schema.optionalKey(PadGlance),
  /**
   * Authored grid for entity.kind === "sheet". Unlike board/pad this is not a
   * projection: the operator types it, the document owns it, and agents read
   * it without a work-plane row behind it.
   */
  sheet: Schema.optionalKey(EtherSheet),
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
 * The authored relationship and optional operator attenuation.
 *
 * Ports, claimability, board wake, watch predicates, fire actions, task-path
 * flow, and scheduler chaining are compiled from the verb plus the two endpoint
 * kinds (`physics/verbs.ts`) — never mirrored. The optional mask can only
 * remove compiled ports. `fromNode` is the verb's semantic source end.
 */
export const EtherEdgeExtension = Schema.Struct({
  verb: Verb,
  /** Operator attenuation only. Omitted grants the verb's compiled ports. */
  mask: Schema.optionalKey(Schema.Array(Port)),
});
export type EtherEdgeExtension = typeof EtherEdgeExtension.Type;

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
  const grant = compileVerb(verb, kinds.get(edge.fromNode), kinds.get(edge.toNode));
  if (grant === undefined) return undefined;
  const mask = edge.ether?.mask;
  return mask === undefined
    ? grant
    : { ...grant, ports: grant.ports.filter((port) => mask.includes(port)) };
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
 * `ether.tasks` and `ether.requests` are special: each carries operator-
 * authored document truth (`name`), so only projected rows — a nonempty
 * `items` array — make them a work projection.
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
    if (isNonEmptyArrayField(tasks, "items")) return true;
    const requests = (ether as { readonly requests?: unknown }).requests;
    return isNonEmptyArrayField(requests, "items");
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
 * a pairing the grammar never admitted — does not survive the pass, and
 * neither does an authored verb the pair cannot hold: that edge already grants
 * nothing in memory, so converting it into an adjacent verb would mint a
 * capability at load time that the live document never had.
 *
 * Surviving edges are stored in the verb's own order: `fromNode` is the verb's
 * source end, with side and end metadata carried across the swap.
 *
 * Node-body `ether.relay` is not a product surface — watch is a compiled facet
 * of a verb, never a node field.
 *
 * `ether.terminal.tokenPressure` (a seat's retired offboard threshold) is
 * dropped: Junto no longer reads context size, and seats offboard themselves.
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
        const terminal = (etherIn as Record<string, unknown>).terminal;
        const retiredPressure =
          terminal !== null &&
          typeof terminal === "object" &&
          !Array.isArray(terminal) &&
          Object.prototype.hasOwnProperty.call(terminal, "tokenPressure");
        if (!Object.prototype.hasOwnProperty.call(etherIn, "relay") && !retiredPressure) {
          return node;
        }
        const { relay: _drop, ...ether } = etherIn as Record<string, unknown>;
        if (retiredPressure) {
          const { tokenPressure: _retired, ...kept } = terminal as Record<string, unknown>;
          ether.terminal = kept;
        }
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
        // A verb its endpoints cannot hold is corrupt, not legacy: it names a
        // relationship this pair has never had. Dropping it is the same answer
        // `compileVerb` already gives in memory — re-inference would hand the
        // edge an adjacent capability on reload that it did not have before.
        const verb = isVerb(authored)
          ? pairHolds(authored, fromKind, toKind)
            ? authored
            : undefined
          : eth !== undefined && Object.prototype.hasOwnProperty.call(eth, "verb")
            ? undefined
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
        // Preserve attenuation verbatim for strict decode. Dropping an invalid
        // mask would accidentally restore all ports on the relationship.
        next.ether = {
          verb,
          ...(eth !== undefined && Object.prototype.hasOwnProperty.call(eth, "mask")
            ? { mask: eth.mask }
            : {}),
        };
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


export type CanvasAuthoritySnapshot = {
  readonly generation: string;
  readonly intentSha256: string;
  readonly documents: ReadonlyMap<string, CanvasDoc>;
};
export type CanvasAuthorityStoredDocument = {
  readonly document: CanvasDoc;
  readonly rawBody: string;
  readonly revisionSha256: string;
};
export type CanvasAuthorityMaterialSnapshot = CanvasAuthoritySnapshot & {
  readonly storedDocuments: ReadonlyMap<string, CanvasAuthorityStoredDocument>;
};
export type InstalledProjectionCanvasChange = {
  readonly name: string;
  readonly detail: { readonly previous: CanvasDoc | undefined; readonly next: CanvasDoc | undefined };
};
