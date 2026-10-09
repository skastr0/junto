import { Schema } from "effect";
import { HarnessId } from "../managed-terminal-templates";
import { ActorSeatId } from "../actor-seat";
import { ActorRef, TaskRef } from "../work-reference";
import { ContentPart } from "../content";
import { ReviewVerdict } from "../crew";
import { Node } from "./kinds";
import { normalizeNode } from "./normalize";
import { SheetGrid } from "./sheet";
import { Wire } from "./wire";

// Frozen input schemas for the one-time database migration. No live model
// imports the retired node bodies, and later Work changes cannot reinterpret
// the installed bytes this reader was written to preserve.
const TextPart = Schema.Struct({
  kind: Schema.Literal("text"),
  text: Schema.String,
});

type TextPart = typeof TextPart.Type;

const UrlPart = Schema.Struct({
  kind: Schema.Literal("url"),
  url: Schema.String,
  mediaType: Schema.optionalKey(Schema.String),
});

type UrlPart = typeof UrlPart.Type;

const DataPart = Schema.Struct({
  kind: Schema.Literal("data"),
  data: Schema.Unknown,
});

type DataPart = typeof DataPart.Type;

const RawPart = Schema.Struct({
  kind: Schema.Literal("raw"),
  bytesBase64: Schema.String,
  mediaType: Schema.optionalKey(Schema.String),
});

type RawPart = typeof RawPart.Type;

const Part = Schema.Union([TextPart,
UrlPart,
DataPart,
RawPart,
ContentPart,]);

type Part = typeof Part.Type;

const MessageRole = Schema.Literals(["user", "agent"]);

type MessageRole = typeof MessageRole.Type;

const WorkMetadata = Schema.Record(Schema.String, Schema.Unknown);

type WorkMetadata = typeof WorkMetadata.Type;

const Message = Schema.Struct({
  messageId: Schema.String,
  role: MessageRole,
  parts: Schema.Array(Part),
  taskId: Schema.optionalKey(Schema.String),
  contextId: Schema.optionalKey(Schema.String),
  referenceTaskIds: Schema.optionalKey(Schema.Array(Schema.String)),
  metadata: Schema.optionalKey(WorkMetadata),
});

type Message = typeof Message.Type;

const TaskState = Schema.Literals(["submitted", "working",
"input-required",
"completed",
"canceled",
"failed",
"rejected",
"auth-required",
"archived",]);

type TaskState = typeof TaskState.Type;

const FinishCriteria = Schema.Struct({
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

type FinishCriteria = typeof FinishCriteria.Type;

const ruleFields = {
  /** ULID minted at authoring. */
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** Omitted is a prose statement; review rules also arm an independent gate. */
  kind: Schema.optionalKey(Schema.Literals(["statement", "requires-review"])),
} as const;

const Rule = Schema.Struct(ruleFields);

type Rule = typeof Rule.Type;

const Ruling = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** ISO timestamp. */
  pinnedAt: Schema.String,
  sourceRequestId: Schema.optionalKey(Schema.String),
});

type Ruling = typeof Ruling.Type;

const Check = Schema.Struct({
  /** ULID minted at authoring. */
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  label: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  command: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

type Check = typeof Check.Type;

const TaskRule = Schema.Struct({
  ...ruleFields,
  /** Tasks node id where this rule must be answered or fork-waived. */
  board: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

type TaskRule = typeof TaskRule.Type;

const TaskAdmission = Schema.Literals(["auto", "approval", "operator"]);

type TaskAdmission = typeof TaskAdmission.Type;

const TasksIncoming = Schema.Struct({
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

type TasksIncoming = typeof TasksIncoming.Type;

const TasksOutgoing = Schema.Struct({
  /** What the agent must write in the handoff note when sending work onward. */
  handoff: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(Schema.Array(Check)),
});

type TasksOutgoing = typeof TasksOutgoing.Type;

const TasksContract = Schema.Struct({
  /** Prose agents read when they claim a task here. */
  instructions: Schema.optionalKey(Schema.String),
  rules: Schema.optionalKey(Schema.Array(Rule)),
  incoming: Schema.optionalKey(TasksIncoming),
  outgoing: Schema.optionalKey(TasksOutgoing),
});

type TasksContract = typeof TasksContract.Type;

const Claim = Schema.Struct({
  ruleId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  refs: Schema.optionalKey(Schema.Array(Schema.String)),
});

type Claim = typeof Claim.Type;

const Waiver = Schema.Struct({
  ruleId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  reason: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

type Waiver = typeof Waiver.Type;

const CompletionEvidence = Schema.Struct({
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

type CompletionEvidence = typeof CompletionEvidence.Type;

const VisitExit = Schema.Literals(["sent-on", "completed", "sent-back"]);

type VisitExit = typeof VisitExit.Type;

const Visit = Schema.Struct({
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

type Visit = typeof Visit.Type;

const TaskDefect = Schema.Struct({
  epoch: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  /** Tasks node id of the visited board the task was sent back to. */
  target: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** ISO timestamp of the defect. */
  at: Schema.String,
});

type TaskDefect = typeof TaskDefect.Type;

const CHECK_OUTPUT_TAIL_MAX_BYTES = 8 * 1024;

const CheckSide = Schema.Literals(["outgoing", "incoming"]);

type CheckSide = typeof CheckSide.Type;

const CheckResult = Schema.Struct({
  checkId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  side: CheckSide,
  command: Schema.String,
  exitCode: Schema.Number.pipe(Schema.check(Schema.isInt())),
  outputTail: Schema.String.pipe(Schema.check(Schema.isMaxLength(CHECK_OUTPUT_TAIL_MAX_BYTES))),
  /** ISO timestamp. */
  at: Schema.String,
  epoch: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

type CheckResult = typeof CheckResult.Type;

const TaskAuthoringFields = {
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

const Task = Schema.Struct({
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

type Task = typeof Task.Type;

const Artifact = Schema.Struct({
  artifactId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  parts: Schema.Array(Part),
  task: Schema.optionalKey(TaskRef),
  metadata: Schema.optionalKey(WorkMetadata),
});

type Artifact = typeof Artifact.Type;

const WorkTasks = Schema.Struct({
  items: Schema.Array(Task),
  name: Schema.optionalKey(Schema.String),
  contract: Schema.optionalKey(TasksContract),
});

type WorkTasks = typeof WorkTasks.Type;

const WorkRequests = Schema.Struct({
  items: Schema.Array(Task),
  name: Schema.optionalKey(Schema.String),
});

type WorkRequests = typeof WorkRequests.Type;

const WorkArtifacts = Schema.Struct({
  items: Schema.Array(Artifact),
});

type WorkArtifacts = typeof WorkArtifacts.Type;

const BoardTopicState = Schema.Literals(["open", "archived"]);

type BoardTopicState = typeof BoardTopicState.Type;

const BoardGlanceTopic = Schema.Struct({
  topicId: Schema.String,
  title: Schema.String,
  state: BoardTopicState,
  postCount: Schema.Number,
  lastActivityAt: Schema.String,
  authorLabel: Schema.optionalKey(Schema.String),
  /** Operator's unread posts on this topic (own posts never count). */
  unreadPostCount: Schema.optionalKey(Schema.Number),
});

type BoardGlanceTopic = typeof BoardGlanceTopic.Type;

const EtherBoard = Schema.Struct({
  topics: Schema.Array(BoardGlanceTopic),
  /** Operator-local unread post count when known (sum over topics). */
  unread: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
});

type EtherBoard = typeof EtherBoard.Type;

const PadGlance = Schema.Struct({
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

type PadGlance = typeof PadGlance.Type;

const EtherTasks = WorkTasks;

type EtherTasks = WorkTasks;

const EtherRequests = WorkRequests;

type EtherRequests = WorkRequests;

const EtherArtifacts = WorkArtifacts;

type EtherArtifacts = WorkArtifacts;

const SHEET_MAX_COLUMNS = 32;

const SHEET_MAX_ROWS = 500;

const SHEET_MAX_CELL_LENGTH = 2_000;

const SHEET_MAX_NAME_LENGTH = 120;

const Identifier = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
);

const SheetColumn = Schema.Struct({
  id: Identifier,
  name: Schema.String.pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_NAME_LENGTH))),
});

type SheetColumn = typeof SheetColumn.Type;

const SheetRow = Schema.Struct({
  id: Identifier,
  /** Column id → cell text. A missing key is an empty cell. */
  cells: Schema.Record(
    Schema.String,
    Schema.String.pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_CELL_LENGTH))),
  ),
});

type SheetRow = typeof SheetRow.Type;

const EtherSheet = Schema.Struct({
  columns: Schema.Array(SheetColumn).pipe(
    Schema.check(Schema.isMaxLength(SHEET_MAX_COLUMNS)),
  ),
  rows: Schema.Array(SheetRow).pipe(Schema.check(Schema.isMaxLength(SHEET_MAX_ROWS))),
});

type EtherSheet = typeof EtherSheet.Type;

const TerminalOnDelete = Schema.Literals(["detach", "kill-session"]);

type TerminalOnDelete = typeof TerminalOnDelete.Type;

const TerminalLaunchKind = Schema.Literals(["shell", "command", "harness"]);

type TerminalLaunchKind = typeof TerminalLaunchKind.Type;

const EtherTerminalLaunch = Schema.Struct({
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

type EtherTerminalLaunch = typeof EtherTerminalLaunch.Type;

const EtherTerminal = Schema.Struct({
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

type EtherTerminal = typeof EtherTerminal.Type;

const BrowserOnDelete = Schema.Literals(["detach", "kill-session"]);

type BrowserOnDelete = typeof BrowserOnDelete.Type;

const EtherBrowser = Schema.Struct({
  profile: Schema.String,
  onDelete: Schema.optionalKey(BrowserOnDelete),
});

type EtherBrowser = typeof EtherBrowser.Type;

const EtherGit = Schema.Struct({
  cwd: Schema.String,
});

type EtherGit = typeof EtherGit.Type;

const EtherEntity = Schema.Struct({
  kind: Schema.String,
  name: Schema.optionalKey(Schema.String),
});

type EtherEntity = typeof EtherEntity.Type;

const EtherHostId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/)),
);

type EtherHostId = typeof EtherHostId.Type;

const EtherRegionPageDefaults = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(EtherHostId),
});

type EtherRegionPageDefaults = typeof EtherRegionPageDefaults.Type;

const EtherRegionPaths = Schema.Record(Schema.String, Schema.String);

type EtherRegionPaths = typeof EtherRegionPaths.Type;

const EtherRegionDefaults = Schema.Struct({
  page: Schema.optionalKey(EtherRegionPageDefaults),
  /** Per-host default working directory for agents/terminals created inside. */
  paths: Schema.optionalKey(EtherRegionPaths),
});

type EtherRegionDefaults = typeof EtherRegionDefaults.Type;

const EtherRegionContract = Schema.Struct({
  rules: Schema.optionalKey(Schema.Array(Rule)),
  rulings: Schema.optionalKey(Schema.Array(Ruling)),
});

type EtherRegionContract = typeof EtherRegionContract.Type;

const EnvSourceBase = {
  /** Stable handle within the region: reports, tokenFrom and edits key on it. */
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** A source that cannot be read refuses the launch instead of being left out. */
  required: Schema.optionalKey(Schema.Boolean),
  /** Applies only on this machine. Absent means every machine. */
  host: Schema.optionalKey(EtherHostId),
} as const;

const EnvName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
);

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

const EnvSource = Schema.Union([
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

type EnvSource = typeof EnvSource.Type;

const EtherRegionEnvironment = Schema.Struct({
  /** Seats inside inherit nothing from regions outside this one. */
  sealed: Schema.optionalKey(Schema.Boolean),
  /** Applied in list order; a later source overrides an earlier one by name. */
  sources: Schema.optionalKey(Schema.Array(EnvSource)),
  /** Extra directories exposed to seats inside (absolute or `~/` paths). */
  folders: Schema.optionalKey(Schema.Array(NonEmpty)),
});

type EtherRegionEnvironment = typeof EtherRegionEnvironment.Type;

const EtherRegion = Schema.Struct({
  hold: Schema.optionalKey(Schema.Boolean),
  instruction: Schema.optionalKey(Schema.String),
  defaults: Schema.optionalKey(EtherRegionDefaults),
  contract: Schema.optionalKey(EtherRegionContract),
  environment: Schema.optionalKey(EtherRegionEnvironment),
});

type EtherRegion = typeof EtherRegion.Type;

const WatchKind = Schema.Literal("stat_threshold");

type WatchKind = typeof WatchKind.Type;

const EtherWatch = Schema.Struct({
  kind: WatchKind,
  // Legacy hermes numeric compare — not the product gauge story
  source: Schema.optionalKey(Schema.Literal("hermes")),
  key: Schema.optionalKey(Schema.String),
  stat: Schema.optionalKey(Schema.String),
  op: Schema.optionalKey(Schema.Literals(["gt", "lt", "eq"])),
  value: Schema.optionalKey(Schema.Number),
});

type EtherWatch = typeof EtherWatch.Type;

const EtherTimer = Schema.Struct({
  everyMinutes: Schema.optionalKey(Schema.Number),
  /** 5-field cron: minute hour day-of-month month day-of-week. */
  expression: Schema.optionalKey(Schema.String),
});

type EtherTimer = typeof EtherTimer.Type;

const EtherNodeExtension = Schema.Struct({
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

type EtherNodeExtension = typeof EtherNodeExtension.Type;

/** Temporary cutover input, confined to the migration and old-row reader. */
export interface LegacyNodeRow {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly z_index: number;
  readonly color?: string | null;
  readonly text_content?: string | null;
  readonly file_path?: string | null;
  readonly file_subpath?: string | null;
  readonly link_url?: string | null;
  readonly group_label?: string | null;
  readonly group_background?: string | null;
  readonly group_background_style?: string | null;
  readonly ether_json?: string | null;
}

const decodeExtension = Schema.decodeUnknownSync(
  Schema.fromJsonString(EtherNodeExtension),
);
const decodeNodeSchema = Schema.decodeUnknownSync(Node);
const decodeNode = (input: unknown) => normalizeNode(decodeNodeSchema(input));
const present = <T>(
  key: string,
  value: T | null | undefined,
): Record<string, T> =>
  value === null || value === undefined ? {} : { [key]: value };

/** A stored row said `local` for the machine it was written on; a row of the model names that machine. */
const STORED_THIS_MACHINE = "local";

const named = (host: string | undefined, thisMachine: string): string =>
  host === undefined || host === STORED_THIS_MACHINE ? thisMachine : host;

const namedDefaults = (defaults: EtherRegionDefaults | undefined, thisMachine: string) =>
  defaults === undefined
    ? undefined
    : {
        ...defaults,
        ...(defaults.page?.host === undefined ? {} : { page: { ...defaults.page, host: named(defaults.page.host, thisMachine) } }),
        ...(defaults.paths === undefined
          ? {}
          : { paths: Object.fromEntries(Object.entries(defaults.paths).map(([host, path]) => [named(host, thisMachine), path])) }),
      };

const namedEnvironment = <E extends { readonly sources?: ReadonlyArray<{ readonly host?: string }> }>(
  environment: E | undefined,
  thisMachine: string,
) =>
  environment?.sources === undefined
    ? environment
    : {
        ...environment,
        sources: environment.sources.map((source) =>
          source.host === undefined ? source : { ...source, host: named(source.host, thisMachine) },
        ),
      };

/** Pure conversion, validates the new kind and never reads or projects Work. */
const decodeStoredKind = (row: LegacyNodeRow, thisMachine: string): Node => {
  const old =
    row.ether_json == null ? undefined : decodeExtension(row.ether_json);
  const base = {
    id: row.node_id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    z: row.z_index,
    ...present("color", row.color),
  };
  const text = row.text_content ?? "";
  // An old card's text was its title on the first line, then mirrored content.
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const labelled = {
    ...base,
    ...(firstLine === "" ? {} : { label: firstLine }),
  };
  const host = named(old?.host, thisMachine);
  if (row.type === "group")
    return decodeNode({
      ...base,
      kind: "region",
      ...present("label", row.group_label),
      hold: old?.region?.hold ?? false,
      ...present("instruction", old?.region?.instruction),
      ...present("defaults", namedDefaults(old?.region?.defaults, thisMachine)),
      ...present("contract", old?.region?.contract),
      ...present("environment", namedEnvironment(old?.region?.environment, thisMachine)),
      ...present("background", row.group_background),
      ...present("backgroundStyle", row.group_background_style),
    });
  switch (old?.entity?.kind) {
    case "agent":
      return decodeNode({
        ...base,
        kind: "agent",
        agentKey: old.entity.name,
        label: firstLine,
        host,
        overseer: old.overseer ?? false,
        bindingId: old.terminal?.bindingId,
        harness: old.terminal?.harness,
        onRemove: old.terminal?.onDelete ?? "detach",
        ...present("launch", old.terminal?.launch),
        ...present("sessionId", old.terminal?.sessionId),
      });
    case "terminal":
      return decodeNode({
        ...labelled,
        kind: "terminal",
        host,
        bindingId: old.terminal?.bindingId,
        onRemove: old.terminal?.onDelete ?? "detach",
        ...present("launch", old.terminal?.launch),
      });
    case "page":
      return decodeNode({
        ...base,
        kind: "page",
        host,
        url: row.link_url ?? "",
        profile: old.browser?.profile ?? "default",
        onRemove: old.browser?.onDelete ?? "kill-session",
      });
    case "task":
      return decodeNode({
        ...base,
        kind: "task",
        ...present("name", old.tasks?.name),
        ...present("contract", old.tasks?.contract),
      });
    case "requests":
      return decodeNode({
        ...base,
        kind: "requests",
        ...present("name", old.requests?.name),
      });
    case "artifacts":
    case "board":
    case "pad":
      return decodeNode({ ...labelled, kind: old.entity.kind });
    case "relay":
      return decodeNode({ ...labelled, kind: "relay", host });
    case "sheet":
      return decodeNode({ ...labelled, kind: "sheet" });
    case "cron":
    case "timer": {
      const minutes = old.timer?.everyMinutes;
      const expression =
        old.timer?.expression ??
        (minutes !== undefined &&
        Number.isInteger(minutes) &&
        minutes > 0 &&
        minutes <= 59
          ? `*/${minutes} * * * *`
          : minutes !== undefined &&
              Number.isInteger(minutes) &&
              minutes > 0 &&
              minutes % 60 === 0 &&
              minutes / 60 <= 23
            ? `0 */${minutes / 60} * * *`
            : undefined);
      return decodeNode({
        ...labelled,
        kind: "cron",
        host,
        ...present("expression", expression),
      });
    }
    case "watcher":
      return decodeNode({
        ...labelled,
        kind: "watcher",
        host,
        ...present("key", old.watch?.key),
        ...present("stat", old.watch?.stat),
        ...present("op", old.watch?.op),
        ...present("value", old.watch?.value),
      });
    case "label":
      return decodeNode({ ...base, kind: "label", text });
    case "git":
      return decodeNode({ ...labelled, kind: "git", cwd: old.git?.cwd });
    default:
      if (old?.entity?.kind === undefined && row.type === "file")
        return decodeNode({
          ...base,
          kind: "file",
          path: row.file_path,
          ...present("subpath", row.file_subpath),
        });
      if (old?.entity?.kind === undefined && row.type === "link")
        return decodeNode({
          ...base,
          kind: "link",
          url: row.link_url ?? "",
        });
      return decodeNode({ ...base, kind: "note", text });
  }
};

export interface StoredNodeConversion {
  readonly node: Node;
  readonly downgraded?: {
    readonly canvas: string;
    readonly id: string;
    readonly storedType: string;
    readonly reason: string;
  };
}

/** Invalid retired descriptors keep their identity and text as a note. */
export const convertLegacyRow = (row: LegacyNodeRow, thisMachine: string): StoredNodeConversion => {
  try {
    const node = decodeStoredKind(row, thisMachine);
    const descriptor =
      row.ether_json == null ? undefined : decodeExtension(row.ether_json);
    const reason = node.kind === "note" && descriptor?.entity?.kind !== undefined
      ? "stored kind is no longer supported; preserved as a note"
      : node.kind === "cron" && node.expression === undefined && descriptor?.timer?.everyMinutes !== undefined
      ? `stored interval ${descriptor.timer.everyMinutes} minutes cannot be expressed as a cron schedule; left unscheduled`
      : undefined;
    return { node, ...(reason === undefined ? {} : { downgraded: {
      canvas: row.canvas_name, id: row.node_id,
      storedType: descriptor?.entity?.kind ?? row.type, reason,
    } }) };
  } catch (cause) {
    const finite = (value: number, fallback: number) =>
      Number.isFinite(value) ? value : fallback;
    const width = finite(row.width, 220),
      height = finite(row.height, 90);
    return {
      node: decodeNode({
        kind: "note",
        id: row.node_id,
        x: finite(row.x, 0),
        y: finite(row.y, 0),
        width: width > 0 ? width : 220,
        height: height > 0 ? height : 90,
        z: Number.isSafeInteger(row.z_index) ? row.z_index : 0,
        text:
          row.text_content ??
          row.group_label ??
          row.file_path ??
          row.link_url ??
          "",
      }),
      downgraded: {
        canvas: row.canvas_name,
        id: row.node_id,
        storedType: row.type,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
};
export const nodeFromLegacyRow = (row: LegacyNodeRow, thisMachine: string): Node =>
  convertLegacyRow(row, thisMachine).node;

const decodeGrid = Schema.decodeUnknownSync(SheetGrid);

/** What an old sheet row held, or nothing when the row is not a sheet. */
export const sheetGridFromLegacyRow = (
  row: LegacyNodeRow,
): SheetGrid | undefined => {
  const old =
    row.ether_json == null ? undefined : decodeExtension(row.ether_json);
  if (old?.entity?.kind !== "sheet") return undefined;
  return decodeGrid({
    columns: old.sheet?.columns ?? [],
    rows: old.sheet?.rows ?? [],
  });
};

export interface LegacyWireRow {
  readonly canvas_name: string;
  readonly edge_id: string;
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly from_side?: string | null;
  readonly to_side?: string | null;
  readonly ether_json?: string | null;
}
const OldWire = Schema.Struct({
  verb: Wire.fields.verb,
  mask: Wire.fields.mask,
});
const decodeOldWire = Schema.decodeUnknownSync(Schema.fromJsonString(OldWire));
const decodeWire = Schema.decodeUnknownSync(Wire);
export const wireFromLegacyRow = (row: LegacyWireRow): Wire => {
  const old = decodeOldWire(row.ether_json);
  return decodeWire({
    id: row.edge_id,
    from: row.from_node_id,
    to: row.to_node_id,
    ...old,
    ...present("fromSide", row.from_side),
    ...present("toSide", row.to_side),
  });
};
