import type {
  BrowserProfileWipeInput,
  BrowserProfileWipeReceipt,
  BrowserSessionState,
  BrowserStopReceipt,
} from "./browser";
export type {
  BrowserProfileWipeInput,
  BrowserProfileWipeReceipt,
  BrowserStopReceipt,
} from "./browser";
import type { DirectoryEntry, DoctorReport, FolderSnapshot, ServiceCheck } from "./contracts";
import type {
  WorkMetadata,
  Task,
  CanvasDoc,
  CanvasNode,
  Part,
  TaskState,
  FinishCriteria,
  CompletionEvidence,
  EtherFlag,
} from "./canvas";
import type { TaskAdmission, TaskPathArm, TaskRule } from "./work-model";
import type { WorkErrorDetails } from "./work-control";
import type { ContentRef } from "./content";
import type {
  DemoEdl,
  DemoStateInfo,
  DemoWriteEdlResult,
} from "./demo";
import type { SnapshotState } from "./entities";
import type { NodeRefKey } from "./node-ref";
import type { CanvasPauseState, PauseScope } from "./pause";
import type { RegionRollup } from "./region-rollup";
import type {
  Settings,
  SettingsOpResult,
  SettingsPatch,
  SettingsSectionKey,
  StationPatch,
} from "./settings";
import type { UsageState } from "./usage";
import type { AgentSeatStateEvent } from "./agent-seat-state";
import type { TerminalSessionSummary } from "./terminal";
import type { HostDirectorySnapshot } from "./host-directory";
import type { GitLogResult, GitShowResult, GitStatusResult } from "./git";
import type { ActorRef } from "./work-protocol";
import type { WorkSeatRecentOpsFeed } from "./work-recent-ops";
import type {
  StateBackupId,
  StateRecoveryExportResult,
  StateRecoveryListResult,
} from "./state-recovery";
import type { UpdateApi } from "./update";
import type { PreambleEvent } from "./preamble";
import type { HostDeployJobSnapshot } from "./deploy-job";
import type {
  ObservabilityLogEntry,
  ObservabilityQuery,
  ObservabilitySnapshot,
} from "./observability";
export type { UpdateApi, UpdateStatus, AvailableRelease, UpdatePhase } from "./update";
export type {
  ObservabilityLogEntry,
  ObservabilityQuery,
  ObservabilitySnapshot,
} from "./observability";

export const IPC_CHANNELS = {
  doctor: "chassis:doctor",
  selectFolder: "chassis:select-folder",
  readDirectory: "chassis:read-directory",
  probeCodex: "chassis:probe-codex",
  listCanvases: "vellum-command:list-canvases",
  readCanvas: "vellum-command:read-canvas",
  writeCanvas: "vellum-command:write-canvas",
  canvasOverseerSet: "vellum-command:canvas-overseer-set",
  createCanvas: "vellum-command:create-canvas",
  deleteCanvas: "vellum-command:delete-canvas",
  exportDigest: "vellum-command:export-digest",
  generatePortfolio: "vellum-command:generate-portfolio",
  getSnapshots: "vellum-command:get-snapshots",
  refreshSnapshots: "vellum-command:refresh-snapshots",
  getUsage: "vellum-command:get-usage",
  refreshUsage: "vellum-command:refresh-usage",
  agentMessage: "vellum-command:agent-message",
  /** Main → renderer: one ephemeral agent preamble. */
  preamble: "vellum-command:preamble",
  chatOpen: "vellum-command:chat-open",
  chatPrompt: "vellum-command:chat-prompt",
  chatPermission: "vellum-command:chat-permission",
  chatSetModel: "vellum-command:chat-set-model",
  chatClose: "vellum-command:chat-close",
  /** Main-owned agent delete lease: lock + tombstone + close. */
  chatBeginNodeDelete: "vellum-command:chat-begin-node-delete",
  /** Release delete lease after document commit or abort. */
  chatFinishNodeDelete: "vellum-command:chat-finish-node-delete",
  getKernelState: "vellum-command:get-kernel-state",
  /** Factory pause plane — canvas-level switch state (born paused). */
  factoryPauseState: "vellum-command:factory-pause-state",
  factoryPauseSet: "vellum-command:factory-pause-set",
  /** Operator Fire now — apply scheduler output-edge effects immediately. */
  schedulerFire: "vellum-command:scheduler-fire",
  regionRollups: "vellum-command:region-rollups",
  /**
   * Put image bytes into the local content store; returns a ContentRef.
   * Canvas notes and image file nodes author through this — never inline Base64
   * in the document.
   */
  contentPutImage: "vellum-command:content-put-image",
  // work plane (serialized canvas mutations)
  workTaskCreate: "vellum-command:work-task-create",
  workTaskDescribe: "vellum-command:work-task-describe",
  workTaskTransition: "vellum-command:work-task-transition",
  workTaskPromote: "vellum-command:work-task-promote",
  workTaskComment: "vellum-command:work-task-comment",
  workTaskRespond: "vellum-command:work-task-respond",
  workTaskClaim: "vellum-command:work-task-claim",
  workRequestResolve: "vellum-command:work-request-resolve",
  workArtifactArchive: "vellum-command:work-artifact-archive",
  workArtifactDelete: "vellum-command:work-artifact-delete",
  workSeatRecentOps: "vellum-command:work-seat-recent-ops",
  workBoardList: "vellum-command:work-board-list",
  workBoardCreateTopic: "vellum-command:work-board-create-topic",
  workBoardPost: "vellum-command:work-board-post",
  workBoardMarkRead: "vellum-command:work-board-mark-read",
  workBoardNotify: "vellum-command:work-board-notify",
  workPadRead: "vellum-command:work-pad-read",
  workPadPatch: "vellum-command:work-pad-patch",
  // browser work surface (partitioned WebContentsView sessions)
  browserProfiles: "vellum-command:browser-profiles",
  browserOpen: "vellum-command:browser-open",
  browserClose: "vellum-command:browser-close",
  browserStop: "vellum-command:browser-stop",
  browserWipeProfile: "vellum-command:browser-wipe-profile",
  browserSessionState: "vellum-command:browser-session-state",
  browserSessionList: "vellum-command:browser-session-list",
  browserSetBounds: "vellum-command:browser-set-bounds",
  browserSurfaceConfig: "vellum-command:browser-surface-config",
  // demo/scripting engine (--vellum-demo only; inert otherwise)
  demoState: "vellum-command:demo-state",
  demoWriteEdl: "vellum-command:demo-write-edl",
  // user settings plane (app-owned SQLite state)
  settingsGet: "vellum-command:settings-get",
  settingsPatch: "vellum-command:settings-patch",
  /** Dedicated transition for normalized protected station topology. */
  settingsSetStationTopology: "vellum-command:settings-set-station-topology",
  settingsReset: "vellum-command:settings-reset",
  // Verified state-backup inventory/export. Destination selection stays Main-owned.
  stateBackupsList: "vellum-command:state-backups-list",
  stateBackupExport: "vellum-command:state-backup-export",
  // OS login item (Electron get/setLoginItemSettings)
  loginItemGet: "vellum-command:login-item-get",
  loginItemSet: "vellum-command:login-item-set",
  // remote host registry (app-owned SQLite state)
  hostsList: "vellum-command:hosts-list",
  /** Tailscale peers visible on the mesh but not yet enrolled. */
  hostsDiscoverPeers: "vellum-command:hosts-discover-peers",
  hostsUpsert: "vellum-command:hosts-upsert",
  hostsRemove: "vellum-command:hosts-remove",
  hostsTest: "vellum-command:hosts-test",
  /** Command Center: stamp Remote station fields on a registered host over SSH. */
  hostsConfigureRemote: "vellum-command:hosts-configure-remote",
  /** Command Center: install/update .app + start Remote station over SSH. */
  hostsDeployRemote: "vellum-command:hosts-deploy-remote",
  /** Live / last deploy job for a host (main-owned; survives panel unmount). */
  hostsDeployJobGet: "vellum-command:hosts-deploy-job-get",
  hostsDeployJobsList: "vellum-command:hosts-deploy-jobs-list",
  /** Main → renderer: deploy job snapshot changed. */
  hostsDeployJobChanged: "vellum-command:hosts-deploy-job-changed",
  /** Effective Remote deploy capability (RELEASE ∩ operator ∩ role). */
  hostsDeployCapabilities: "vellum-command:hosts-deploy-capabilities",
  // Optional, user-owned Box CLI provider. Vellum Command never imports account inventory.
  boxAvailability: "vellum-command:box-availability",
  boxListOwned: "vellum-command:box-list-owned",
  boxCreate: "vellum-command:box-create",
  boxRefresh: "vellum-command:box-refresh",
  boxPrepareSsh: "vellum-command:box-prepare-ssh",
  boxStop: "vellum-command:box-stop",
  boxResume: "vellum-command:box-resume",
  /** Drop Vellum Command ownership + fleet host; does not destroy the provider Box. */
  boxDetach: "vellum-command:box-detach",
  // main -> renderer freshness challenge; renderer -> main bootstrap receipt.
  // The opaque challenge is generation identity, never product authority.
  rendererSurfaceChallenge: "vellum-command:renderer-surface-challenge",
  rendererSurfaceReady: "vellum-command:renderer-surface-ready",
  // Command Center auto-update (Mac; readiness-gated install)
  updateGetState: "vellum-command:update-get-state",
  updateCheck: "vellum-command:update-check",
  updateRestartAndInstall: "vellum-command:update-restart-and-install",
  updateStateChanged: "vellum-command:update-state-changed",
  // main -> renderer pushes
  nodeRefOpened: "vellum-command:node-ref-opened",
  nodeRefOpenedAck: "vellum-command:node-ref-opened-ack",
  canvasFlushRequested: "vellum-command:canvas-flush-requested",
  canvasFlushComplete: "vellum-command:canvas-flush-complete",
  canvasQuiesceAndFlushRequested: "vellum-command:canvas-quiesce-and-flush-requested",
  canvasQuiesceAndFlushStarted: "vellum-command:canvas-quiesce-and-flush-started",
  canvasQuiesceAndFlushComplete: "vellum-command:canvas-quiesce-and-flush-complete",
  canvasChanged: "vellum-command:canvas-changed",
  snapshotsChanged: "vellum-command:snapshots-changed",
  usageChanged: "vellum-command:usage-changed",
  settingsChanged: "vellum-command:settings-changed",
  chatEvent: "vellum-command:chat-event",
  kernelChanged: "vellum-command:kernel-changed",
  terminalList: "vellum-command:terminal-list",
  terminalCreate: "vellum-command:terminal-create",
  terminalGet: "vellum-command:terminal-get",
  terminalKill: "vellum-command:terminal-kill",
  /** Fence terminal creates and await exact owned teardown before node commit. */
  terminalBeginNodeDelete: "vellum-command:terminal-begin-node-delete",
  /** Release the terminal node-delete fence after commit or abort. */
  terminalFinishNodeDelete: "vellum-command:terminal-finish-node-delete",
  terminalBindCanvas: "vellum-command:terminal-bind-canvas",
  terminalAttach: "vellum-command:terminal-attach",
  terminalRelease: "vellum-command:terminal-release",
  terminalWrite: "vellum-command:terminal-write",
  /** Operator multi-prompt / managed seat paste+CR (idle-gated drive). */
  terminalManagedPrompt: "vellum-command:terminal-managed-prompt",
  terminalResize: "vellum-command:terminal-resize",
  terminalShutdown: "vellum-command:terminal-shutdown",
  terminalEvent: "vellum-command:terminal-event",
  hostDirectoryRead: "vellum-command:host-directory-read",
  gitStatus: "vellum-command:git-status",
  gitLog: "vellum-command:git-log",
  gitShow: "vellum-command:git-show",
  /** Fail-soft model list for the managed-terminal harness picker. */
  managedTerminalModels: "vellum-command:managed-terminal-models",
  /** Fail-soft Hermes profile list for the harness picker. */
  managedTerminalProfiles: "vellum-command:managed-terminal-profiles",
  /**
   * Feature-enabled harnesses + local CLI install probe for the palette.
   * Only `installed: true` rows should be offered for authoring.
   */
  managedTerminalHarnesses: "vellum-command:managed-terminal-harnesses",
  /** Main → renderer: managed-agent seat state (idle/working/attention/unknown). */
  agentSeatStateSnapshot: "vellum-command:agent-seat-state-snapshot",
  agentSeatStateChanged: "vellum-command:agent-seat-state-changed",
  browserSessionChanged: "vellum-command:browser-session-changed",
  // Developer observability ring (process-local; UI gated by advanced.logsExplorer)
  observabilityQuery: "vellum-command:observability-query",
  observabilityClear: "vellum-command:observability-clear",
  /** Renderer interest: enable live push while the explorer is open. */
  observabilityWatch: "vellum-command:observability-watch",
  observabilityUnwatch: "vellum-command:observability-unwatch",
  /** Main → renderer: one structured log entry (only while watched). */
  observabilityLog: "vellum-command:observability-log",
  /** Main → renderer: ring was cleared. */
  observabilityCleared: "vellum-command:observability-cleared",
} as const;

/** Operator-authored per-task admission and wait overlay on the create surface. */
export type TaskCreateOptions = {
  readonly admission: TaskAdmission;
  /** Explicit task wait before the first claim, in ms; wins over the board default. */
  readonly waitForMs?: number;
};

export interface ChassisApi {
  readonly doctor: () => Promise<DoctorReport>;
  readonly selectFolder: () => Promise<FolderSnapshot | null>;
  readonly readDirectory: (path: string) => Promise<ReadonlyArray<DirectoryEntry>>;
  readonly probeCodex: () => Promise<ServiceCheck>;
}

export interface CanvasSummary {
  readonly name: string;
  readonly modifiedAt: string;
}

export interface CanvasReadResult {
  readonly name: string;
  readonly doc: CanvasDoc;
  /**
   * Projection-only execution identities for actor nodes on this canvas.
   * These are compiled by main from the active portfolio and never authored
   * into the canvas document.
   */
  readonly actorRefs: ReadonlyArray<ActorRef>;
  /** SHA-256 identity of the exact canonical database body. */
  readonly revision: string;
  /**
   * Opaque monotonic identity of this canvas's runtime Work projection.
   * This is deliberately separate from the authorial body revision: agents
   * advance SQLite Work without authoring the canvas.
   */
  readonly workRevision: string;
}

export interface CanvasWriteResult {
  /** SHA-256 identity of the exact canonical database body committed. */
  readonly revision: string;
}

/** Direct operator delegation; never accepted by the agent command plane. */
export interface CanvasOverseerSetInput {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly overseer: boolean;
  readonly expectedRevision: string;
}

export interface CanvasOverseerSetResult {
  readonly binding: { readonly hostId: string; readonly bindingId: string };
  readonly overseer: boolean;
  readonly affected: ReadonlyArray<{ readonly name: string; readonly revision: string }>;
}

export interface CanvasFlushRequest {
  readonly requestId: string;
}

export interface CanvasFlushResult extends CanvasFlushRequest {
  readonly ok: boolean;
}

export interface CanvasQuiesceAndFlushRequest extends CanvasFlushRequest {}

export interface CanvasQuiesceAndFlushOutcome {
  readonly ok: boolean;
  /** True once renderer mutation admission is monotonically closed. */
  readonly quiesced: boolean;
}

export interface CanvasQuiesceAndFlushResult
  extends CanvasQuiesceAndFlushRequest, CanvasQuiesceAndFlushOutcome {}

export interface DigestResult {
  readonly digest: string;
  readonly path: string;
}

// Renderer passes open-document identity keys so adapters can enrich where a
// node actually binds (hermes agents). Live plane is hermes-only.
export interface BindingHint {
  readonly source: "hermes";
  readonly key: string;
}

// --- kernel state types (wire) -----------------------------------------------

export interface WatcherRuntimeState {
  readonly status: "satisfied" | "pending" | "unknown";
  readonly detail: string;
  readonly lastFiredAt?: number;
}

/**
 * Retired Region Pulse product shape. Kept for KernelStateRepository debug
 * pulse-ring schema identity / tests only — not on the live kernel wire.
 */
export interface PulseRecord {
  readonly id: string;
  readonly at: number;
  readonly canvasName: string;
  readonly sourceNodeId: string;
  readonly regionId?: string;
  readonly kind: "watcher" | "timer" | "manual";
  readonly summary: string;
  readonly delivered: ReadonlyArray<string>;
  readonly dry: boolean;
}

/** Live edge phase + blocked closure projected from the kernel cycle. */
export interface ExecutionSnapshot {
  readonly phaseByEdgeId: Readonly<Record<string, "blocks" | "relates">>;
  readonly detailByEdgeId: Readonly<Record<string, string>>;
  readonly blocked: ReadonlyArray<string>;
  readonly blockedEdgeIds: ReadonlyArray<string>;
  readonly reasonsByNodeId: Readonly<
    Record<
      string,
      ReadonlyArray<
        | { readonly kind: "edge"; readonly edgeId: string; readonly fromNodeId: string; readonly detail: string }
        | { readonly kind: "seed"; readonly detail: string }
        | { readonly kind: "work"; readonly requestId: string; readonly targetNodeId: string; readonly detail: string }
      >
    >
  >;
}

export interface KernelSnapshot {
  readonly canvases: Readonly<
    Record<
      string,
      {
        readonly watchers: Record<string, WatcherRuntimeState>;
        readonly nextFire: Record<string, number>;
        readonly flagOverrides: Readonly<
          Record<string, Partial<Record<EtherFlag, boolean>>>
        >;
        readonly execution?: ExecutionSnapshot;
      }
    >
  >;
}

// factoryPauseSet is SQLite-first (pause-plane.ts persist): ok carries the
// fresh post-write state so the renderer never re-derives; a refused write
// (state fault, failed persist) changed nothing anywhere and carries the
// reason for the operator to see inline — never swallowed.
export type FactoryPauseSetResult =
  | { readonly ok: true; readonly state: CanvasPauseState }
  | { readonly ok: false; readonly error: string };

export type WorkErrorCode =
  | "canvas_not_found"
  | "node_not_found"
  | "task_not_found"
  | "illegal_kind"
  | "illegal_transition"
  | "claim_contention"
  | "invalid"
  | "not_ready"
  | "unadmitted"
  | "fork_choice"
  | "wrong_home"
  | "operator_owned";

/** Success carries the written document + revision so the renderer can
 *  baseline without racing canvasChanged → flush → recovery-canvas. */
export type WorkOpResult<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly doc: CanvasDoc;
      readonly revision: string;
      readonly disposition: "applied" | "queued";
      /** Human-readable context for an idempotent or otherwise notable mutation. */
      readonly message?: string;
    }
  | {
      readonly ok: false;
      readonly code: WorkErrorCode;
      readonly message: string;
      /** Structured facts for the control plane; never parsed out of message. */
      readonly details?: WorkErrorDetails;
    };

// --- hermes agent messaging -------------------------------------------------

export interface AgentReply {
  readonly ok: boolean;
  readonly reply?: string;
  readonly error?: string;
}

// --- hermes attached chat (ACP) ---------------------------------------------
// One live ACP session per agent node ("<host>:<profile>"). The main process
// owns the `hermes acp` child (local or over ssh) and relays the protocol;
// the renderer renders. Payloads stay loosely typed — the ACP update object
// is forwarded verbatim and the UI narrows defensively.

export interface ChatModelChoice {
  readonly modelId: string;
  readonly description?: string;
}

export interface ChatOpenResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly sessionId?: string;
  readonly resumed?: boolean;
  readonly models?: ReadonlyArray<ChatModelChoice>;
}

export interface ChatTurnResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly stopReason?: string; // end_turn | cancelled | refusal | ...
}

// Pushed on "vellum-command:chat-event" for every ACP notification / agent request.
export interface ChatEvent {
  readonly agentKey: string;
  // ACP sessionUpdate kind (agent_message_chunk, agent_thought_chunk,
  // tool_call, tool_call_update, plan, usage_update,
  // available_commands_update, ...) or the synthetic kinds
  // "permission_request" (carries requestId + options), "status", "error".
  readonly kind: string;
  readonly payload: unknown;
}

export interface NodeRefOpenedEvent {
  readonly ref: NodeRefKey;
  readonly canvasName: string;
  readonly nodeId: string;
}

// Internal main -> preload envelope. The delivery id never crosses the
// context bridge; it acknowledges the owner's current in-memory delivery.
export interface NodeRefOpenedDelivery extends NodeRefOpenedEvent {
  readonly deliveryId: string;
}

export interface ChatApi {
  // Spawn/attach the agent's ACP session. resumeSessionId reattaches a prior
  // conversation (hermes advertises loadSession + resume). The session mints no
  // principal: ACP is a transport and holds no factory identity.
  readonly chatOpen: (
    agentKey: string,
    resumeSessionId?: string,
  ) => Promise<ChatOpenResult>;
  // One turn: prompt text plus optional context blocks (node digests) sent as
  // additional content blocks. Resolves when the turn ends; streaming arrives
  // via chat events.
  readonly chatPrompt: (agentKey: string, text: string, contextBlocks?: ReadonlyArray<string>) => Promise<ChatTurnResult>;
  // Answer a pending permission request (optionId: allow_once | allow_session
  // | allow_always | deny | deny_always).
  readonly chatPermission: (agentKey: string, requestId: string, optionId: string) => Promise<{ ok: boolean }>;
  readonly chatSetModel: (agentKey: string, modelId: string) => Promise<{ ok: boolean; error?: string }>;
  readonly chatClose: (
    agentKey: string,
  ) => Promise<{ ok: boolean; clean?: boolean }>;
  /**
   * Main-owned agent delete lease: locks keys, admits chatOpen tombstones,
   * starts verified close. Finish after document commit or abort.
   */
  readonly chatBeginNodeDelete: (
    resources: ReadonlyArray<NodeDeleteResource>,
  ) => Promise<ChatBeginNodeDeleteResult>;
  readonly chatFinishNodeDelete: (
    leaseId: string,
    outcome: ChatFinishNodeDeleteOutcome,
  ) => Promise<ChatFinishNodeDeleteResult>;
  readonly onChatEvent: (listener: (event: ChatEvent) => void) => () => void;
}

/** Resource targeted by a Main-owned node-delete lease (agents only for Cut 6). */
export type NodeDeleteResource = {
  readonly kind: "agent";
  readonly agentKey: string;
};

export type ChatBeginNodeDeleteResult =
  | {
      readonly ok: true;
      readonly leaseId: string;
      readonly closeResults: ReadonlyArray<{
        readonly agentKey: string;
        readonly ok: boolean;
        readonly clean: boolean;
      }>;
    }
  | { readonly ok: false; readonly error: string };

export type ChatFinishNodeDeleteOutcome = "committed" | "aborted";

export type ChatFinishNodeDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface VellumCommandSchedulerApi {
  /** Fire one selected scheduler's outbound does edges only. */
  readonly schedulerFire: (
    canvas: string,
    sourceNodeId: string,
  ) => Promise<
    | {
        readonly ok: true;
        readonly sourceNodeId: string;
        readonly kind: "relay" | "cron" | "gauge";
        readonly applied: number;
        readonly message: string;
      }
    | { readonly ok: false; readonly error: string }
  >;
}

export interface VellumCommandHermesIntegrationApi {
  readonly generatePortfolio: (
    name: string,
    options?: { all?: boolean },
  ) => Promise<CanvasReadResult>;
  readonly refreshSnapshots: (
    hints?: ReadonlyArray<BindingHint>,
  ) => Promise<SnapshotState>;
  readonly agentMessage: (key: string, text: string) => Promise<AgentReply>;
}

export interface VellumCommandApi extends UpdateApi {
  /** Read-only platform marker for renderer geometry and copy. */
  readonly platform: NodeJS.Platform;
  /** Internal bootstrap receipt emitted after React commits the product shell. */
  readonly rendererSurfaceReady: () => void;
  readonly listCanvases: () => Promise<ReadonlyArray<CanvasSummary>>;
  readonly readCanvas: (name: string) => Promise<CanvasReadResult>;
  readonly writeCanvas: (
    name: string,
    doc: CanvasDoc,
    expectedRevision?: string,
  ) => Promise<CanvasWriteResult>;
  readonly canvasOverseerSet: (
    input: CanvasOverseerSetInput,
  ) => Promise<CanvasOverseerSetResult>;
  readonly createCanvas: (name: string) => Promise<CanvasReadResult>;
  readonly deleteCanvas: (name: string) => Promise<{ name: string }>;
  readonly exportDigest: (name: string) => Promise<DigestResult>;
  readonly getSnapshots: () => Promise<SnapshotState>;
  // Kernel state and control (headless kernel in main process).
  readonly getKernelState: () => Promise<KernelSnapshot>;
  // Factory pause plane (app-state switch; the factory is born paused and the
  // first play is an explicit operator confirmation — @shared/pause law).
  readonly factoryPauseState: (canvas: string) => Promise<CanvasPauseState>;
  readonly factoryPauseSet: (
    canvas: string,
    scope: PauseScope,
    paused: boolean,
  ) => Promise<FactoryPauseSetResult>;
  // Region severity rollups for the bottom bar, derived live per call from
  // the document + snapshots + ACP chat activity (shared/region-rollup.ts).
  readonly regionRollups: (name: string) => Promise<ReadonlyArray<RegionRollup>>;
  /**
   * Ingest image bytes into the content store. Used by canvas image nodes and
   * note embeds. Bytes never land in CanvasDoc; only the returned ContentRef
   * (via content object URL) is authored into the document.
   */
  readonly contentPutImage: (input: {
    readonly bytesBase64: string;
    readonly mediaType: string;
    readonly displayName?: string;
  }) => Promise<
    | { readonly ok: true; readonly ref: ContentRef }
    | { readonly ok: false; readonly error: string }
  >;
  // work plane — repository-native SQLite mutations; canvas reads provide
  // topology and runtime projection only.
  readonly workTaskCreate: (
    canvas: string,
    nodeId: string,
    brief: string,
    metadata?: WorkMetadata,
    reason?: string,
    /** First-class task media (raw image parts) authored into the task thread. */
    media?: ReadonlyArray<Part>,
    /** Same-sink hard prerequisites (task ids). */
    dependsOn?: ReadonlyArray<string>,
    finishCriteria?: FinishCriteria,
    /** Board-addressed rules; set at creation, immutable on generic transitions. */
    rules?: ReadonlyArray<TaskRule>,
    /** Per-task admission overlay and optional wait before the first claim. */
    options?: TaskCreateOptions,
  ) => Promise<WorkOpResult<Task>>;
  readonly workTaskDescribe: (
    canvas: string,
    nodeId: string,
    taskId: string,
    brief: string,
  ) => Promise<WorkOpResult<Task>>;
  readonly workTaskTransition: (
    canvas: string,
    nodeId: string,
    taskId: string,
    state: TaskState,
    note?: string,
    completionEvidence?: CompletionEvidence,
    path?: TaskPathArm,
  ) => Promise<WorkOpResult<Task>>;
  /** Operator approval of an approval-admission task for its current epoch. */
  readonly workTaskPromote: (
    canvas: string,
    nodeId: string,
    taskId: string,
    note?: string,
  ) => Promise<WorkOpResult<Task>>;
  /** Append an operator-authored comment through the canonical task message channel. */
  readonly workTaskComment: (
    canvas: string,
    nodeId: string,
    taskId: string,
    text: string,
  ) => Promise<WorkOpResult<Task["history"][number]>>;
  readonly workTaskRespond: (
    canvas: string,
    nodeId: string,
    taskId: string,
    responseText: string,
    disposition: "working" | "rejected",
  ) => Promise<WorkOpResult<Task>>;
  readonly workTaskClaim: (
    canvas: string,
    nodeId: string,
    taskId: string,
    actor: string,
  ) => Promise<WorkOpResult<Task>>;
  readonly workRequestResolve: (
    canvas: string,
    nodeId: string,
    taskId: string,
    responseText: string,
    disposition: "completed" | "rejected",
  ) => Promise<WorkOpResult<Task>>;
  readonly workArtifactArchive: (
    canvas: string,
    nodeId: string,
    artifactId: string,
    archived: boolean,
  ) => Promise<WorkOpResult<import("./work-model").Artifact>>;
  readonly workArtifactDelete: (
    canvas: string,
    nodeId: string,
    artifactId: string,
  ) => Promise<WorkOpResult<{ readonly artifactId: string }>>;
  readonly workSeatRecentOps: (
    canvas: string,
    nodeId: string,
    limit?: number,
  ) => Promise<WorkOpResult<WorkSeatRecentOpsFeed>>;
  /** Full topics+posts from SQLite (operator detail). Glance stays titles-only. */
  readonly workBoardList: (
    canvas: string,
    nodeId: string,
    topicId?: string,
  ) => Promise<
    WorkOpResult<{
      readonly topics: ReadonlyArray<
        import("./work-model").BoardTopicView
      >;
    }>
  >;
  readonly workBoardCreateTopic: (
    canvas: string,
    nodeId: string,
    title: string,
    body: string | undefined,
    notify: boolean,
  ) => Promise<
    WorkOpResult<{
      readonly topic: import("./work-model").BoardTopic;
      readonly notify: boolean;
    }>
  >;
  readonly workBoardPost: (
    canvas: string,
    nodeId: string,
    topicId: string,
    text: string,
  ) => Promise<
    WorkOpResult<{ readonly post: import("./work-model").BoardPost }>
  >;
  readonly workBoardMarkRead: (
    canvas: string,
    nodeId: string,
    topicId: string,
    upToPosition?: number,
  ) => Promise<WorkOpResult<{ readonly topicId: string }>>;
  /** Operator megaphone: wake Notify-ON seats for a board/topic. */
  readonly workBoardNotify: (
    canvas: string,
    nodeId: string,
    topicId?: string,
  ) => Promise<WorkOpResult<{ readonly wakeCount: number }>>;
  readonly workPadRead: (
    canvas: string,
    nodeId: string,
    pinId?: string,
  ) => Promise<
    WorkOpResult<{
      readonly revision: number;
      readonly pad: import("./pad").Pad;
      readonly digest: string;
      readonly svg: string;
      readonly lookHere?: import("./pad-project").PadLookHere;
    }>
  >;
  readonly workPadPatch: (
    canvas: string,
    nodeId: string,
    patches: ReadonlyArray<import("./pad").PadPatch>,
  ) => Promise<
    WorkOpResult<{
      readonly revision: number;
      readonly pad: import("./pad").Pad;
      readonly digest: string;
    }>
  >;
  readonly onNodeRefOpened: (
    listener: (event: NodeRefOpenedEvent) => void | Promise<void>,
  ) => () => void;
  /** Main-process close gate: resolves only after pending canvas writes settle. */
  readonly onCanvasFlushRequested: (listener: () => void | Promise<void>) => () => void;
  /** Signal-only gate: closes renderer authoring, then drains admitted writes. */
  readonly onCanvasQuiesceAndFlushRequested: (
    listener: (
      acknowledgeQuiesced: () => void,
    ) => CanvasQuiesceAndFlushOutcome | Promise<CanvasQuiesceAndFlushOutcome>,
  ) => () => void;
  readonly onCanvasChanged: (listener: (name: string) => void) => () => void;
  /** Optional for older renderer bridges; present in the current preload. */
  readonly onPreamble?: (listener: (event: PreambleEvent) => void) => () => void;
  readonly onSnapshotsChanged: (listener: (state: SnapshotState) => void) => () => void;
  readonly onKernelChanged: (listener: (snapshot: KernelSnapshot) => void) => () => void;
  // User settings document (main owns the SQLite row; renderer holds a live projection).
  readonly settingsGet: () => Promise<SettingsOpResult>;
  readonly settingsPatch: (patch: SettingsPatch) => Promise<SettingsOpResult>;
  /**
   * Topology transitions only (station.role / hostId / agentHostId /
   * supervisedPreferred). Generic settingsPatch rejects these.
   */
  readonly settingsSetStationTopology: (
    station: StationPatch,
  ) => Promise<SettingsOpResult>;
  readonly settingsReset: (section?: SettingsSectionKey) => Promise<SettingsOpResult>;
  /** Verified retained backups only; never scans arbitrary paths. */
  readonly stateBackupsList: () => Promise<StateRecoveryListResult>;
  /** Main opens the native save dialog; the renderer supplies no path. */
  readonly stateBackupExport: (
    id: StateBackupId,
  ) => Promise<StateRecoveryExportResult>;
  readonly onSettingsChanged: (listener: (settings: Settings) => void) => () => void;
  /**
   * Developer observability ring — process-local Effect + console logs.
   * UI gated by `settings.advanced.logsExplorer`.
   */
  readonly observabilityQuery: (
    query?: ObservabilityQuery,
  ) => Promise<ObservabilitySnapshot>;
  readonly observabilityClear: () => Promise<ObservabilitySnapshot>;
  /** Open a live-push interest slot (call while explorer is mounted). */
  readonly observabilityWatch: () => Promise<ObservabilitySnapshot>;
  readonly observabilityUnwatch: () => Promise<{ readonly ok: true }>;
  readonly onObservabilityLog: (
    listener: (entry: ObservabilityLogEntry) => void,
  ) => () => void;
  readonly onObservabilityCleared: (
    listener: (payload: {
      readonly newestId: number;
      readonly total: number;
      readonly dropped: number;
    }) => void,
  ) => () => void;
  /** OS login item — read real state; never assume. */
  readonly loginItemGet: () => Promise<LoginItemOpResult>;
  /** Explicit toggle only; no silent enrollment. */
  readonly loginItemSet: (openAtLogin: boolean) => Promise<LoginItemOpResult>;
}

/** Optional fleet/hosts product surface. Omitted from preload when Fleet UI is off. */
export interface VellumCommandHostsApi {
  // Remote host registry (SSH fleet surface).
  readonly hostsList: () => Promise<HostsOpResult>;
  readonly hostsDiscoverPeers: () => Promise<HostsDiscoverPeersResult>;
  readonly hostsUpsert: (host: unknown) => Promise<HostsOpResult>;
  readonly hostsRemove: (id: string) => Promise<HostsOpResult>;
  readonly hostsTest: (id: string) => Promise<HostsTestResult>;
  /** Install / configure Vellum Command Remote station settings on a registered remote host. */
  readonly hostsConfigureRemote: (id: string) => Promise<HostsConfigureRemoteResult>;
  /** Install/update Vellum Command.app on remote + start station (term control ready). */
  readonly hostsDeployRemote: (
    input: HostsDeployRemoteInput,
  ) => Promise<HostsDeployRemoteResult>;
  /** Live / last main-owned deploy job for a host (survives panel unmount). */
  readonly hostsDeployJobGet: (
    hostId: string,
  ) => Promise<HostDeployJobSnapshot | null>;
  readonly hostsDeployJobsList: () => Promise<ReadonlyArray<HostDeployJobSnapshot>>;
  /** Subscribe to main-process deploy job updates. */
  readonly onHostsDeployJobChanged: (
    listener: (job: HostDeployJobSnapshot) => void,
  ) => () => void;
  /** SoT for Remote deployment capability gates. */
  readonly hostsDeployCapabilities: () => Promise<HostsDeployCapabilitiesResult>;
  readonly boxAvailability: () => Promise<BoxAvailabilityResult>;
  readonly boxListOwned: () => Promise<BoxFleetResult>;
  readonly boxCreate: () => Promise<BoxFleetResult>;
  readonly boxRefresh: (boxId: string) => Promise<BoxFleetResult>;
  readonly boxPrepareSsh: (boxId: string) => Promise<BoxFleetResult>;
  readonly boxStop: (boxId: string) => Promise<BoxFleetResult>;
  readonly boxResume: (boxId: string) => Promise<BoxFleetResult>;
  /** Remove from Vellum Command ownership + fleet only; Box account machine remains. */
  readonly boxDetach: (boxId: string) => Promise<BoxFleetResult>;
}

/** Optional provider-usage product surface. Omitted from preload when disabled. */
export interface VellumCommandUsageApi {
  readonly getUsage: () => Promise<UsageState>;
  readonly refreshUsage: () => Promise<UsageState>;
  readonly onUsageChanged: (listener: (state: UsageState) => void) => () => void;
}

export interface HostsOpResult {
  readonly ok: boolean;
  readonly hosts?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly kind: "local" | "remote";
    readonly sshEndpoint?: string;
    readonly capabilities: ReadonlyArray<"browser" | "terminal" | "hermes">;
    readonly hermesId?: string;
    readonly appearance?: {
      readonly color?: string;
      readonly glyph?: string;
    };
  }>;
  readonly code?: string;
  readonly message?: string;
}

export interface BoxAvailabilityResult {
  readonly ok: boolean;
  readonly available: boolean;
  readonly authenticated: boolean;
  readonly healthy: boolean;
  readonly executable?: string;
  readonly version?: string;
  readonly account?: string;
  readonly detail: string;
  readonly message?: string;
}

export interface BoxFleetResource {
  readonly boxId: string;
  readonly hostId?: string;
  readonly name: string;
  readonly ip: string | null;
  readonly state: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly enrolledAt: string;
  readonly sshPreparedAt?: string;
  readonly sshVerifiedAt?: string;
}

export interface BoxFleetResult {
  readonly ok: boolean;
  readonly boxes?: ReadonlyArray<BoxFleetResource>;
  readonly box?: BoxFleetResource;
  /** Provider identity retained when a post-create local stage fails. */
  readonly recoveryBoxId?: string;
  readonly provisioningStage?: string;
  readonly code?: string;
  readonly message?: string;
}

/** A Tailscale mesh peer not yet enrolled in the host registry. */
export interface DiscoveredPeer {
  readonly name: string;
  readonly addresses: ReadonlyArray<string>;
  readonly online: boolean;
  readonly os?: string;
}

/** hostsDiscoverPeers — degrades to `{ ok: true, peers: [] }`, never throws. */
export interface HostsDiscoverPeersResult {
  readonly ok: boolean;
  readonly peers?: ReadonlyArray<DiscoveredPeer>;
  readonly code?: string;
  readonly message?: string;
}

/** OS login-item state from Electron getLoginItemSettings. */
export interface LoginItemState {
  readonly openAtLogin: boolean;
  readonly openAsHidden: boolean;
  readonly wasOpenedAtLogin: boolean;
  readonly wasOpenedAsHidden: boolean;
}

/** Startup authority is platform-owned; renderer copy never grants it. */
export type StartupProvider = "apple-login-items" | "systemd-supervision" | "unsupported";

export interface LoginItemOpResult {
  readonly ok: boolean;
  readonly provider: StartupProvider;
  readonly state?: LoginItemState;
  readonly message?: string;
}

export interface HostsTestResult {
  readonly ok: boolean;
  readonly detail: string;
  /** Round-trip ms of the probe (present on probe success/failure paths). */
  readonly latencyMs?: number;
  /** Raw SSH link truth — `ok` is the strict all-checks verdict; this is
   * whether the host answered at all (remote probes only). */
  readonly reachability?: "reachable" | "unreachable" | "unknown";
  /** Process-local Station wire compatibility; never persisted in the status document. */
  readonly protocol?: import("./station-status").StationProtocolObservation;
  /**
   * Linux host-capability Doctor observation from the closed SSH probe.
   * Present only when the remote probe returned a closed capability record.
   */
  readonly linuxCapabilities?: import("./linux-host-capabilities").LinuxHostCapabilityObservation;
  /** Complete bounded Station observation used by Fleet detail and Doctor. */
  readonly observation?: import("./station-status").StationRemoteObservation;
  /** Main-owned compatibility projection. Renderer consumers never derive it. */
  readonly compatibility?: import("./fleet-compatibility-snapshot").FleetPeerCompatibilitySnapshot;
  readonly code?: string;
  readonly message?: string;
}

/** Result of hostsConfigureRemote — ok/detail/error for doctor + Hosts UI. */
export interface HostsConfigureRemoteResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly code?: string;
  readonly message?: string;
  readonly station?: {
    readonly role: string;
    readonly hostId: string;
    readonly agentHostId?: string;
    readonly supervisedPreferred: boolean;
  };
  /** Configure continues into the activate lifecycle; same recovery contract as Deploy. */
  readonly recoveryAction?: HostsDeployRemoteRecoveryAction;
}

/** Fixed operator recovery for a deployment refusal; never carries a command or path. */
export type HostsDeployRemoteRecoveryAction =
  {
    readonly kind: "close-active-vellum-terminals";
    readonly activeTerminalSessions: number;
  };

export interface HostsDeployRemoteInput {
  readonly id: string;
}

/** Effective Remote deploy gates — see shared/deploy-capabilities.ts. */
export type HostsDeployCapabilitiesResult =
  | import("./deploy-capabilities").HostsDeployCapabilities
  | {
      readonly ok: false;
      readonly code?: string;
      readonly message?: string;
    };


/** Result of hostsDeployRemote — Remote station install/update and readiness probe. */
export interface HostsDeployRemoteResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly code?: string;
  readonly message?: string;
  readonly stages?: readonly string[];
  readonly outcome?: "ready" | "failed" | "indeterminate";
  readonly packageState?: "present" | "previous" | "unknown";
  readonly role?: "remote" | "previous" | "unknown";
  readonly version?: string;
  readonly lastSeen?: string;
  readonly statusRecorded?: boolean;
  readonly recoveryAction?: HostsDeployRemoteRecoveryAction;
}

export type {
  HostDeployJobSnapshot,
  HostDeployJobStatus,
} from "./deploy-job";

// The attached-chat surface is declared separately and merged into the
// preload bridge alongside VellumCommandApi.
export interface VellumCommandChatApi extends ChatApi {}

/**
 * Open the terminal surface declared by this exact canvas node.
 *
 * The node kind is the command discriminant: `agent` occupies an actor seat,
 * while `terminal` opens raw shell geography. Stable identity, placement,
 * launch, harness, and label all come from the node rather than loose wire
 * fields, so a freshly authored node can start before its debounced canvas
 * save reaches Main without gaining a second source of authority.
 */
export interface TerminalCreateInput {
  readonly node: CanvasNode;
  readonly canvasName?: string;
  readonly resume?: boolean;
  readonly cols?: number;
  readonly rows?: number;
}

/** Fail-soft model option for the harness picker (main enumeration). */
export interface ManagedTerminalModelOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly efforts?: readonly string[];
}

export interface ManagedTerminalModelsResult {
  readonly models: readonly ManagedTerminalModelOption[];
  readonly source: "cache" | "aliases" | "command" | "empty";
  readonly error?: string;
  /** Template efforts when model list carries none. */
  readonly efforts: readonly string[];
}

export interface ManagedTerminalProfileOption {
  readonly name: string;
  readonly model: string;
  readonly gateway?: string;
}

export interface ManagedTerminalProfilesResult {
  readonly profiles: readonly ManagedTerminalProfileOption[];
  readonly source: "cache" | "aliases" | "command" | "empty";
  readonly error?: string;
}

/** One feature-enabled harness with local install status for the palette. */
export interface ManagedTerminalHarnessOption {
  readonly harness: string;
  readonly displayName: string;
  readonly binary: string;
  readonly installed: boolean;
}

export interface ManagedTerminalHarnessesResult {
  readonly harnesses: readonly ManagedTerminalHarnessOption[];
}

export type TerminalNodeDeleteResource = {
  readonly bindingId: string;
  readonly hostId?: string;
};

export type TerminalBeginNodeDeleteResult =
  | {
      readonly ok: true;
      readonly leaseId: string;
      readonly closeResults: ReadonlyArray<{
        readonly bindingId: string;
        readonly hostId: string;
        readonly clean: true;
      }>;
    }
  | { readonly ok: false; readonly error: string };

export type TerminalFinishNodeDeleteOutcome = "committed" | "aborted";

export type TerminalFinishNodeDeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface TerminalAttachInput {
  readonly bindingId: string;
  readonly mode: "control" | "observe";
  readonly takeover?: boolean;
  /** Route to remote station when not local. */
  readonly hostId?: string;
}

export interface VellumCommandGitApi {
  readonly gitStatus: (cwd: string) => Promise<GitStatusResult>;
  readonly gitLog: (cwd: string, limit?: number) => Promise<GitLogResult>;
  readonly gitShow: (cwd: string, sha: string) => Promise<GitShowResult>;
}

export interface VellumCommandTerminalApi {
  readonly terminalList: (hostId?: string) => Promise<readonly TerminalSessionSummary[]>;
  readonly terminalCreate: (input: TerminalCreateInput) => Promise<TerminalSessionSummary>;
  readonly terminalGet: (bindingId: string, hostId?: string) => Promise<TerminalSessionSummary | undefined>;
  readonly terminalKill: (bindingId: string, hostId?: string) => Promise<boolean>;
  readonly terminalBeginNodeDelete: (
    resources: ReadonlyArray<TerminalNodeDeleteResource>,
  ) => Promise<TerminalBeginNodeDeleteResult>;
  readonly terminalFinishNodeDelete: (
    leaseId: string,
    outcome: TerminalFinishNodeDeleteOutcome,
  ) => Promise<TerminalFinishNodeDeleteResult>;
  /** Read one bounded directory page on the selected local or Remote host. */
  readonly hostDirectoryRead: (
    hostId: string,
    path?: string,
  ) => Promise<HostDirectorySnapshot>;
  readonly terminalBindCanvas: (
    bindingId: string,
    ref: { canvasName?: string; nodeId?: string } | null,
    hostId?: string,
  ) => Promise<void>;
  readonly terminalAttach: (input: TerminalAttachInput) => Promise<unknown>;
  readonly terminalRelease: (leaseId: string) => Promise<boolean>;
  readonly terminalWrite: (leaseId: string, data: string, encoding?: "utf8" | "base64") => Promise<boolean>;
  /**
   * Submit one managed-agent prompt (bracketed paste + CR) via the idle-gated
   * drive. Optional canvas/node wakes a lazy seat first. Does not require a
   * renderer control lease.
   */
  readonly terminalManagedPrompt: (input: {
    readonly bindingId: string;
    readonly text: string;
    readonly canvasName?: string;
    readonly nodeId?: string;
  }) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  readonly terminalResize: (leaseId: string, cols: number, rows: number) => Promise<boolean>;
  readonly onTerminalEvent: (listener: (event: unknown) => void) => () => void;
  /** Fail-soft model enumeration for one harness (empty list = use defaults). */
  readonly managedTerminalModels: (
    harness: string,
  ) => Promise<ManagedTerminalModelsResult>;
  /** Fail-soft Hermes profile enumeration. */
  readonly managedTerminalProfiles: () => Promise<ManagedTerminalProfilesResult>;
  /**
   * Feature-enabled harnesses with local CLI install status.
   * Palette filters to `installed` before offering a seat.
   */
  readonly managedTerminalHarnesses: () => Promise<ManagedTerminalHarnessesResult>;
  /** Current managed-seat projection for renderer restart hydration. */
  readonly agentSeatStateSnapshot: () => Promise<ReadonlyArray<AgentSeatStateEvent>>;
  /** Main → renderer: managed-agent seat state (idle/working/attention/unknown). */
  readonly onAgentSeatStateChanged: (
    listener: (event: AgentSeatStateEvent) => void,
  ) => () => void;
}

// --- demo/scripting engine (--vellum-demo only) ------------------------------
// Outside demo mode: demoState answers { active: false } and the other two
// answer ok:false — handlers are always registered, behavior is flag-gated.

export interface VellumCommandDemoApi {
  readonly demoState: () => Promise<DemoStateInfo>;
  readonly demoWriteEdl: (edl: DemoEdl) => Promise<DemoWriteEdlResult>;
}

// --- browser work surface (partitioned WebContentsView; not a corpus join) ---

export interface BrowserProfileInfo {
  readonly id: string;
  readonly label?: string;
  readonly default?: boolean;
}

export interface BrowserOpResult<T = unknown> {
  readonly ok: boolean;
  readonly data?: T;
  readonly code?: string;
  readonly message?: string;
}

export interface BrowserOpenInput {
  readonly ref: NodeRefKey;
}

/** Renderer-measured DOM rect where the native view should sit (CSS px). */
export interface BrowserSurfaceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserSessionInfo {
  readonly sessionId: string;
  readonly ref: NodeRefKey;
  readonly nodeId: string;
  readonly hostId: string;
  readonly url: string;
  readonly profile: string;
  readonly state: BrowserSessionState;
  readonly attached: boolean;
  readonly title?: string;
  readonly lastError?: string;
}

/** Dock/pool limits from BrowserProfileService config — renderer reads, never guesses. */
export interface BrowserSurfaceConfigInfo {
  readonly maxVisibleSurfaces: number;
  readonly maxWarmSessions: number;
}

export interface VellumCommandBrowserApi {
  readonly browserProfiles: () => Promise<BrowserOpResult<ReadonlyArray<BrowserProfileInfo>>>;
  readonly browserSurfaceConfig: () => Promise<BrowserOpResult<BrowserSurfaceConfigInfo>>;
  readonly browserOpen: (input: BrowserOpenInput) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly browserClose: (sessionId: string) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly browserStop: (sessionId: string) => Promise<BrowserOpResult<BrowserStopReceipt>>;
  readonly browserWipeProfile: (
    input: BrowserProfileWipeInput,
  ) => Promise<BrowserOpResult<BrowserProfileWipeReceipt>>;
  readonly browserSessionState: (sessionId: string) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly browserSessionList: () => Promise<BrowserOpResult<ReadonlyArray<BrowserSessionInfo>>>;
  readonly browserSetBounds: (
    sessionId: string,
    bounds: BrowserSurfaceBounds,
  ) => Promise<BrowserOpResult<BrowserSessionInfo>>;
  readonly onBrowserSessionChanged: (
    listener: (session: BrowserSessionInfo) => void,
  ) => () => void;
}
