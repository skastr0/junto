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
  A2AMetadata,
  A2ATask,
  Artifact,
  CanvasDoc,
  Message,
  TaskState,
} from "./canvas";
import type {
  DemoCommand,
  DemoCommandResult,
  DemoEdl,
  DemoStateInfo,
  DemoWriteEdlResult,
} from "./demo";
import type { SnapshotState } from "./entities";
import type { NodeRefKey } from "./node-ref";
import type { RegionRollup } from "./region-rollup";
import type {
  Settings,
  SettingsOpResult,
  SettingsPatch,
  SettingsSectionKey,
} from "./settings";
import type { UsageState } from "./usage";
import type { CanvasPullResult } from "./canvas-pull";
export type {
  CanvasPullResult,
  CanvasPullStatus,
  CanvasPullFileResult,
  CanvasPullFileFailure,
} from "./canvas-pull";

export const IPC_CHANNELS = {
  doctor: "chassis:doctor",
  selectFolder: "chassis:select-folder",
  readDirectory: "chassis:read-directory",
  probeCodex: "chassis:probe-codex",
  prismDryRun: "chassis:prism-dry-run",
  listCanvases: "vellum:list-canvases",
  readCanvas: "vellum:read-canvas",
  writeCanvas: "vellum:write-canvas",
  createCanvas: "vellum:create-canvas",
  deleteCanvas: "vellum:delete-canvas",
  /** Remote station: pull canvases from Command Center over SSH (read-only). */
  pullCanvases: "vellum:pull-canvases",
  exportDigest: "vellum:export-digest",
  generatePortfolio: "vellum:generate-portfolio",
  getSnapshots: "vellum:get-snapshots",
  refreshSnapshots: "vellum:refresh-snapshots",
  getUsage: "vellum:get-usage",
  refreshUsage: "vellum:refresh-usage",
  agentIdentity: "vellum:agent-identity",
  agentAvatar: "vellum:agent-avatar",
  agentMessage: "vellum:agent-message",
  chatOpen: "vellum:chat-open",
  chatPrompt: "vellum:chat-prompt",
  chatPermission: "vellum:chat-permission",
  chatSetModel: "vellum:chat-set-model",
  chatClose: "vellum:chat-close",
  getKernelState: "vellum:get-kernel-state",
  armRegion: "vellum:arm-region",
  pulseRegion: "vellum:pulse-region",
  regionRollups: "vellum:region-rollups",
  // A2A work plane (serialized canvas mutations)
  workTaskCreate: "vellum:work-task-create",
  workTaskTransition: "vellum:work-task-transition",
  workTaskClaim: "vellum:work-task-claim",
  workMessageAppend: "vellum:work-message-append",
  workRequestCreate: "vellum:work-request-create",
  workRequestResolve: "vellum:work-request-resolve",
  workArtifactPublish: "vellum:work-artifact-publish",
  // herdr work surface
  herdrHosts: "vellum:herdr-hosts",
  herdrEnsureServer: "vellum:herdr-ensure-server",
  herdrListSessions: "vellum:herdr-list-sessions",
  herdrListWorkspaces: "vellum:herdr-list-workspaces",
  herdrListTabs: "vellum:herdr-list-tabs",
  herdrListPanes: "vellum:herdr-list-panes",
  herdrListAgents: "vellum:herdr-list-agents",
  herdrGetMeta: "vellum:herdr-get-meta",
  /** Marks pane seen (done → idle). Stock: herdr agent focus <pane_id>. */
  herdrMarkPaneSeen: "vellum:herdr-mark-pane-seen",
  herdrCreateWorkspace: "vellum:herdr-create-workspace",
  herdrCreateTab: "vellum:herdr-create-tab",
  herdrCreatePane: "vellum:herdr-create-pane",
  herdrKillPane: "vellum:herdr-kill-pane",
  herdrKillTab: "vellum:herdr-kill-tab",
  herdrMirrorState: "vellum:herdr-mirror-state",
  herdrStreamOpen: "vellum:herdr-stream-open",
  herdrStreamInput: "vellum:herdr-stream-input",
  herdrStreamPasteImage: "vellum:herdr-stream-paste-image",
  herdrStreamResize: "vellum:herdr-stream-resize",
  herdrStreamScroll: "vellum:herdr-stream-scroll",
  herdrStreamClose: "vellum:herdr-stream-close",
  herdrObserveTouch: "vellum:herdr-observe-touch",
  herdrObserveRetained: "vellum:herdr-observe-retained",
  /** Host-scoped process→port→URL projection (read cache). */
  herdrServiceMapGet: "vellum:herdr-service-map-get",
  /** Intent probe (open/sync) — rate-limited host queue. */
  herdrServiceMapProbe: "vellum:herdr-service-map-probe",
  herdrServiceMapEvent: "vellum:herdr-service-map-event",
  /** Host Tailscale Serve / SVC catalog (cached). */
  herdrServeCatalogGet: "vellum:herdr-serve-catalog-get",
  herdrServeCatalogRefresh: "vellum:herdr-serve-catalog-refresh",
  // browser work surface (partitioned WebContentsView sessions)
  browserProfiles: "vellum:browser-profiles",
  browserOpen: "vellum:browser-open",
  browserClose: "vellum:browser-close",
  browserStop: "vellum:browser-stop",
  browserWipeProfile: "vellum:browser-wipe-profile",
  browserSessionState: "vellum:browser-session-state",
  browserSessionList: "vellum:browser-session-list",
  browserSetBounds: "vellum:browser-set-bounds",
  browserSurfaceConfig: "vellum:browser-surface-config",
  // trusted-renderer browser automation requests (bearer material never crosses IPC)
  browserAutomationEnable: "vellum:browser-automation-enable",
  browserAutomationList: "vellum:browser-automation-list",
  browserAutomationRevoke: "vellum:browser-automation-revoke",
  // demo/scripting engine (--vellum-demo only; inert otherwise)
  demoState: "vellum:demo-state",
  demoCommand: "vellum:demo-command",
  demoWriteEdl: "vellum:demo-write-edl",
  // user settings plane (schema document under ~/.vellum/settings.json)
  settingsGet: "vellum:settings-get",
  settingsPatch: "vellum:settings-patch",
  settingsReset: "vellum:settings-reset",
  // remote host registry (~/.vellum/hosts.json)
  hostsList: "vellum:hosts-list",
  hostsUpsert: "vellum:hosts-upsert",
  hostsRemove: "vellum:hosts-remove",
  hostsTest: "vellum:hosts-test",
  /** Command Center: stamp Remote station fields on a registered host over SSH. */
  hostsConfigureRemote: "vellum:hosts-configure-remote",
  // main -> renderer pushes
  nodeRefOpened: "vellum:node-ref-opened",
  nodeRefOpenedAck: "vellum:node-ref-opened-ack",
  canvasFlushRequested: "vellum:canvas-flush-requested",
  canvasFlushComplete: "vellum:canvas-flush-complete",
  canvasChanged: "vellum:canvas-changed",
  snapshotsChanged: "vellum:snapshots-changed",
  usageChanged: "vellum:usage-changed",
  settingsChanged: "vellum:settings-changed",
  chatEvent: "vellum:chat-event",
  kernelChanged: "vellum:kernel-changed",
  herdrStreamEvent: "vellum:herdr-stream-event",
  herdrMirrorEvent: "vellum:herdr-mirror-event",
  browserSessionChanged: "vellum:browser-session-changed",
} as const;

export interface ChassisApi {
  readonly doctor: () => Promise<DoctorReport>;
  readonly selectFolder: () => Promise<FolderSnapshot | null>;
  readonly readDirectory: (path: string) => Promise<ReadonlyArray<DirectoryEntry>>;
  readonly probeCodex: () => Promise<ServiceCheck>;
  readonly prismDryRun: () => Promise<ServiceCheck>;
}

export interface CanvasSummary {
  readonly name: string;
  readonly path: string;
  readonly modifiedAt: string;
}

export interface CanvasReadResult {
  readonly name: string;
  readonly path: string;
  readonly doc: CanvasDoc;
  /** SHA-256 identity of the exact file bytes read from disk. */
  readonly revision: string;
}

export interface CanvasWriteResult {
  /** SHA-256 identity of the exact file bytes committed to disk. */
  readonly revision: string;
}

export interface CanvasFlushRequest {
  readonly requestId: string;
}

export interface CanvasFlushResult extends CanvasFlushRequest {
  readonly ok: boolean;
}

export interface DigestResult {
  readonly digest: string;
  readonly path: string;
}

// Renderer passes the open document's bindings so adapters only pay for
// per-project detail (e.g. quasar session counts) where a node actually binds.
export interface BindingHint {
  readonly source: "tower" | "quasar" | "booth" | "hermes";
  readonly key: string;
}

// --- kernel state types (wire) -----------------------------------------------

export interface WatcherRuntimeState {
  readonly status: "satisfied" | "pending" | "unknown";
  readonly detail: string;
  readonly lastFiredAt?: number;
}

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
  readonly phaseByEdgeId: Readonly<Record<string, "blocks" | "depends" | "relates">>;
  readonly detailByEdgeId: Readonly<Record<string, string>>;
  readonly blocked: ReadonlyArray<string>;
  readonly blockedEdgeIds: ReadonlyArray<string>;
  readonly reasonsByNodeId: Readonly<
    Record<
      string,
      ReadonlyArray<
        | { readonly kind: "edge"; readonly edgeId: string; readonly fromNodeId: string; readonly detail: string }
        | { readonly kind: "relay"; readonly viaNodeId: string; readonly edgeId: string }
        | { readonly kind: "seed"; readonly detail: string }
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
        readonly armed: Record<string, boolean>;
        readonly nextFire: Record<string, number>;
        readonly execution?: ExecutionSnapshot;
      }
    >
  >;
  readonly pulseLog: ReadonlyArray<PulseRecord>;
  // Durable-intent surfacing (both additive). `fault` is set when persisted
  // arming state could not be loaded — armed regions were NOT resumed and the
  // operator must see that loudly, never infer it. `orphanedArming` lists
  // armed `canvas::region` keys whose canvas/region no longer exists in any
  // hydrated document — the arm-intent is preserved, surfaced, never dropped.
  readonly fault?: string;
  readonly orphanedArming?: ReadonlyArray<string>;
}

// armRegion is transactional: the store write happens BEFORE the in-memory
// arming map mutates, so a failed persist leaves memory and disk in sync and
// the caller learns the change did not stick. ok:false carries the reason
// (store write failure, or a boot-time arming fault) for the renderer to
// surface inline near the arming control — never swallowed.
export interface ArmRegionResult {
  readonly ok: boolean;
  readonly error?: string;
}

export type WorkErrorCode =
  | "canvas_not_found"
  | "node_not_found"
  | "task_not_found"
  | "illegal_kind"
  | "illegal_transition"
  | "claim_contention"
  | "invalid";

/** Success carries the written document + revision so the renderer can
 *  baseline without racing canvasChanged → flush → recovery-canvas. */
export type WorkOpResult<T> =
  | { readonly ok: true; readonly data: T; readonly doc: CanvasDoc; readonly revision: string }
  | { readonly ok: false; readonly code: WorkErrorCode; readonly message: string };

// --- glyph rows for kernel watchers / criteria (no live private browse) -----

export interface TowerGlyphRow {
  readonly glyphId: string;
  readonly orbit: string;
  readonly title: string;
  readonly state: string; // backlog|exploring|committed|building|reviewing|done|abandoned
  readonly updatedAt: number; // epoch ms
}


// --- hermes agent identity + messaging -------------------------------------

// Enriched, non-secret identity for one fleet agent. Tokens and device ids
// NEVER cross this boundary.
export interface AgentIdentity {
  readonly key: string; // "<host>:<profile>"
  readonly displayName?: string; // e.g. "PROFILE-13" from identity-brief.md
  readonly matrixUserId?: string; // e.g. "@profile-13:remote-a...."
  readonly homeRoomName?: string;
  readonly hasAvatar: boolean;
}

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

// Pushed on "vellum:chat-event" for every ACP notification / agent request.
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
// context bridge; it acknowledges one durable open-url relay record exactly.
export interface NodeRefOpenedDelivery extends NodeRefOpenedEvent {
  readonly deliveryId: string;
}

export interface ChatApi {
  // Spawn/attach the agent's ACP session. resumeSessionId reattaches a prior
  // conversation (hermes advertises loadSession + resume).
  readonly chatOpen: (agentKey: string, resumeSessionId?: string) => Promise<ChatOpenResult>;
  // One turn: prompt text plus optional context blocks (node digests) sent as
  // additional content blocks. Resolves when the turn ends; streaming arrives
  // via chat events.
  readonly chatPrompt: (agentKey: string, text: string, contextBlocks?: ReadonlyArray<string>) => Promise<ChatTurnResult>;
  // Answer a pending permission request (optionId: allow_once | allow_session
  // | allow_always | deny | deny_always).
  readonly chatPermission: (agentKey: string, requestId: string, optionId: string) => Promise<{ ok: boolean }>;
  readonly chatSetModel: (agentKey: string, modelId: string) => Promise<{ ok: boolean; error?: string }>;
  readonly chatClose: (agentKey: string) => Promise<{ ok: boolean }>;
  readonly onChatEvent: (listener: (event: ChatEvent) => void) => () => void;
}

export interface VellumApi {
  readonly listCanvases: () => Promise<ReadonlyArray<CanvasSummary>>;
  readonly readCanvas: (name: string) => Promise<CanvasReadResult>;
  readonly writeCanvas: (
    name: string,
    doc: CanvasDoc,
    expectedRevision?: string,
  ) => Promise<CanvasWriteResult>;
  readonly createCanvas: (name: string) => Promise<CanvasReadResult>;
  readonly deleteCanvas: (name: string) => Promise<{ name: string }>;
  /** Remote-only: pull full canvases from Command Center into local ~/.vellum/canvases. */
  readonly pullCanvases: () => Promise<CanvasPullResult>;
  readonly exportDigest: (name: string) => Promise<DigestResult>;
  // Merge the live corpus (tower/quasar/booth projects) onto the named canvas
  // as bound, hydrated nodes. Preserves existing nodes; appends new ones.
  // { all: true } includes every indexed repo, not just owned/registered.
  readonly generatePortfolio: (
    name: string,
    options?: { all?: boolean },
  ) => Promise<CanvasReadResult>;
  readonly getSnapshots: () => Promise<SnapshotState>;
  readonly refreshSnapshots: (hints?: ReadonlyArray<BindingHint>) => Promise<SnapshotState>;
  // Provider usage plane (codexbar CLI first). Fail-open: empty / ok:false
  // snapshots when the CLI is absent — renderer hides the HUD.
  readonly getUsage: () => Promise<UsageState>;
  readonly refreshUsage: () => Promise<UsageState>;
  // Source browsing (read-only; feeds inspector detail views, never nodes).
  // Hermes fleet: identity enrichment, lazy avatar (data: URI), and messaging.
  readonly agentIdentity: (key: string) => Promise<AgentIdentity | null>;
  readonly agentAvatar: (key: string) => Promise<string | null>;
  readonly agentMessage: (key: string, text: string) => Promise<AgentReply>;
  // Kernel state and control (headless kernel in main process).
  readonly getKernelState: () => Promise<KernelSnapshot>;
  readonly armRegion: (canvasName: string, regionId: string, armed: boolean) => Promise<ArmRegionResult>;
  readonly pulseRegion: (canvasName: string, regionId: string, opts?: unknown) => Promise<void>;
  // Region severity rollups for the bottom bar, derived live per call from
  // the document + snapshots + ACP chat activity (shared/region-rollup.ts).
  readonly regionRollups: (name: string) => Promise<ReadonlyArray<RegionRollup>>;
  // A2A work plane — all mutations serialized through main canvas write path.
  readonly workTaskCreate: (
    canvas: string,
    nodeId: string,
    brief: string,
    metadata?: A2AMetadata,
  ) => Promise<WorkOpResult<A2ATask>>;
  readonly workTaskTransition: (
    canvas: string,
    nodeId: string,
    taskId: string,
    state: TaskState,
    note?: string,
  ) => Promise<WorkOpResult<A2ATask>>;
  readonly workTaskClaim: (
    canvas: string,
    nodeId: string,
    taskId: string,
    actor: string,
  ) => Promise<WorkOpResult<A2ATask>>;
  readonly workMessageAppend: (
    canvas: string,
    nodeId: string,
    taskId: string | null,
    message: Message,
  ) => Promise<WorkOpResult<Message>>;
  readonly workRequestCreate: (
    canvas: string,
    nodeId: string,
    brief: string,
    metadata?: A2AMetadata,
  ) => Promise<WorkOpResult<A2ATask>>;
  readonly workRequestResolve: (
    canvas: string,
    nodeId: string,
    taskId: string,
    responseText: string,
    disposition: "completed" | "rejected",
  ) => Promise<WorkOpResult<A2ATask>>;
  readonly workArtifactPublish: (
    canvas: string,
    nodeId: string,
    artifact: Artifact,
  ) => Promise<WorkOpResult<Artifact>>;
  readonly onNodeRefOpened: (
    listener: (event: NodeRefOpenedEvent) => void | Promise<void>,
  ) => () => void;
  /** Main-process close gate: resolves only after pending canvas writes settle. */
  readonly onCanvasFlushRequested: (listener: () => void | Promise<void>) => () => void;
  readonly onCanvasChanged: (listener: (name: string) => void) => () => void;
  readonly onSnapshotsChanged: (listener: (state: SnapshotState) => void) => () => void;
  readonly onUsageChanged: (listener: (state: UsageState) => void) => () => void;
  readonly onKernelChanged: (listener: (snapshot: KernelSnapshot) => void) => () => void;
  // User settings document (Effect Schema aggregate; main owns the file).
  readonly settingsGet: () => Promise<SettingsOpResult>;
  readonly settingsPatch: (patch: SettingsPatch) => Promise<SettingsOpResult>;
  readonly settingsReset: (section?: SettingsSectionKey) => Promise<SettingsOpResult>;
  readonly onSettingsChanged: (listener: (settings: Settings) => void) => () => void;
  // Remote host registry (SSH fleet surface).
  readonly hostsList: () => Promise<HostsOpResult>;
  readonly hostsUpsert: (host: unknown) => Promise<HostsOpResult>;
  readonly hostsRemove: (id: string) => Promise<HostsOpResult>;
  readonly hostsTest: (id: string) => Promise<HostsTestResult>;
  /** Install / configure Vellum Remote station settings on a registered remote host. */
  readonly hostsConfigureRemote: (id: string) => Promise<HostsConfigureRemoteResult>;
}

export interface HostsOpResult {
  readonly ok: boolean;
  readonly hosts?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly kind: "local" | "remote";
    readonly endpoint?: string;
    readonly capabilities: ReadonlyArray<"herdr" | "hermes">;
    readonly hermesId?: string;
  }>;
  readonly code?: string;
  readonly message?: string;
}

export interface HostsTestResult {
  readonly ok: boolean;
  readonly detail: string;
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
    readonly commandCenterRef: string;
    readonly supervisedPreferred: boolean;
  };
}

// The attached-chat surface is declared separately and merged into the
// preload bridge alongside VellumApi.
export interface VellumChatApi extends ChatApi {}

// --- herdr work surface (PTY panes; not hermes ACP) -------------------------

export interface HerdrHostInfo {
  readonly id: string;
  readonly label: string;
}

export interface HerdrOpResult<T = unknown> {
  readonly ok: boolean;
  readonly data?: T;
  readonly code?: string;
  readonly message?: string;
}

export interface HerdrSessionInfo {
  readonly name: string;
  readonly default?: boolean;
  readonly running?: boolean;
}

export interface HerdrWorkspaceInfo {
  readonly workspaceId: string;
  readonly label?: string;
  readonly tabCount?: number;
  readonly paneCount?: number;
  readonly agentStatus?: string;
}

export interface HerdrTabInfo {
  readonly tabId: string;
  readonly workspaceId?: string;
  readonly label?: string;
  readonly paneCount?: number;
  readonly agentStatus?: string;
}

export interface HerdrAgentSessionInfo {
  readonly agent?: string;
  readonly kind?: string;
  readonly source?: string;
  readonly value?: string;
}

export interface HerdrPaneScrollInfo {
  readonly offsetFromBottom?: number;
  readonly maxOffsetFromBottom?: number;
  readonly viewportRows?: number;
}

export interface HerdrProcessInfo {
  readonly name?: string;
  readonly cmdline?: string;
  readonly pid?: number;
}

/** Projected host service (dev server) state for a herdr pane — never from herdr alone. */
export type HerdrServiceHealth =
  | "unknown"
  | "pending"
  | "live"
  | "stale"
  | "dead"
  | "skipped";

export interface HerdrServicePortInfo {
  readonly port: number;
  readonly protocol?: "tcp" | "udp";
  readonly address?: string;
}

export interface HerdrServiceMapInfo {
  readonly hostId: string;
  readonly session?: string | null;
  readonly paneId: string;
  readonly health: HerdrServiceHealth;
  readonly processes?: ReadonlyArray<HerdrProcessInfo>;
  readonly interesting?: boolean;
  readonly ports?: ReadonlyArray<HerdrServicePortInfo>;
  readonly url?: string;
  readonly hostBase?: string;
  readonly serveLabel?: string;
  readonly serveJoined?: boolean;
  readonly checkedAt?: number;
  readonly error?: string;
}

export type HerdrServeEntryKind = "svc" | "web" | "tcp-forward";

export interface HerdrServeEntryInfo {
  readonly kind: HerdrServeEntryKind;
  readonly id: string;
  readonly label: string;
  readonly publicUrl?: string;
  readonly publicHost?: string;
  readonly publicPort?: number;
  readonly path?: string;
  readonly localPort?: number;
  readonly https?: boolean;
}

export interface HerdrServeCatalogInfo {
  readonly hostId: string;
  readonly entries: ReadonlyArray<HerdrServeEntryInfo>;
  readonly services: ReadonlyArray<HerdrServeEntryInfo>;
  readonly fetchedAt?: number;
  readonly error?: string;
}

export interface HerdrPaneInfo {
  readonly paneId: string;
  readonly workspaceId?: string;
  readonly tabId?: string;
  readonly terminalId?: string;
  readonly cwd?: string;
  readonly foregroundCwd?: string;
  readonly agent?: string;
  readonly agentStatus?: string;
  readonly agentSession?: HerdrAgentSessionInfo;
  readonly label?: string;
  readonly focused?: boolean;
  readonly preview?: string;
  readonly revision?: number;
  readonly scroll?: HerdrPaneScrollInfo;
  readonly workspaceLabel?: string;
  readonly tabLabel?: string;
  readonly processes?: ReadonlyArray<HerdrProcessInfo>;
  /** Optional service projection (process→port→url); sticky in renderer cache. */
  readonly service?: HerdrServiceMapInfo;
}

export interface HerdrStreamOpenInput {
  readonly hostId: string;
  readonly session?: string | null;
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
  readonly takeover?: boolean;
}

export interface HerdrRetainedPayload {
  readonly frames: ReadonlyArray<string>;
  readonly cols?: number;
  readonly rows?: number;
}

export interface HerdrStreamOpenResult {
  readonly ok: boolean;
  readonly streamId?: string;
  readonly message?: string;
  /** Retained observe frames (base64 ANSI, [full, ...deltas] in order) —
   * painted synchronously before live control frames arrive. */
  readonly retained?: HerdrRetainedPayload;
}

/** Warm a pooled read-only observe stream for a terminal (LRU-touch). */
export interface HerdrObserveTouchInput {
  readonly hostId: string;
  readonly session?: string | null;
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
}

/**
 * Pointer position in terminal cells for wheel/mouse forwarding.
 * herdr routes wheel by app mode: mouse-reporting apps get an SGR wheel event
 * at this cell, so a missing/wrong cell scrolls the wrong region (or nothing).
 * `modifiers` uses crossterm bits: SHIFT=1, CONTROL=2, ALT=4.
 */
export interface HerdrPointerCell {
  readonly column: number;
  readonly row: number;
  readonly modifiers: number;
}

/** High-frequency main→renderer stream push (not request/response per frame). */
export interface HerdrStreamEvent {
  readonly streamId: string;
  readonly type: "frame" | "closed" | "error";
  readonly bytes?: string;
  readonly encoding?: string;
  readonly full?: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly seq?: number;
  readonly reason?: string;
  readonly message?: string;
}

/** Main → renderer push when a host's mirror state changes. `kind: "state"`
 * marks a freshness flip (fresh↔stale); `kind: "change"` is a data change. */
export interface HerdrMirrorEvent {
  readonly hostId: string;
  readonly kind: "change" | "state";
  readonly fresh: boolean;
}

export interface HerdrMirrorStateInfo {
  readonly hostId: string;
  readonly fresh: boolean;
  readonly lastSyncAt?: number;
}

export interface VellumHerdrApi {
  readonly herdrHosts: () => Promise<ReadonlyArray<HerdrHostInfo>>;
  readonly herdrEnsureServer: (
    hostId: string,
    session?: string | null,
  ) => Promise<HerdrOpResult<{ readonly running: boolean; readonly started: boolean }>>;
  readonly herdrListSessions: (hostId: string) => Promise<HerdrOpResult<ReadonlyArray<HerdrSessionInfo>>>;
  readonly herdrListWorkspaces: (
    hostId: string,
    session?: string | null,
  ) => Promise<HerdrOpResult<ReadonlyArray<HerdrWorkspaceInfo>>>;
  readonly herdrListTabs: (
    hostId: string,
    session?: string | null,
    workspaceId?: string,
  ) => Promise<HerdrOpResult<ReadonlyArray<HerdrTabInfo>>>;
  readonly herdrListPanes: (
    hostId: string,
    session?: string | null,
    workspaceId?: string,
  ) => Promise<HerdrOpResult<ReadonlyArray<HerdrPaneInfo>>>;
  readonly herdrListAgents: (
    hostId: string,
    session?: string | null,
  ) => Promise<HerdrOpResult<ReadonlyArray<HerdrPaneInfo>>>;
  readonly herdrGetMeta: (
    hostId: string,
    session: string | null | undefined,
    paneId: string,
  ) => Promise<HerdrOpResult<HerdrPaneInfo>>;
  readonly herdrServiceMapGet: (
    hostId: string,
    session: string | null | undefined,
    paneId: string,
  ) => Promise<HerdrOpResult<HerdrServiceMapInfo | null>>;
  /** Enqueue intent probe (Sync / open terminal / open page). */
  readonly herdrServiceMapProbe: (
    hostId: string,
    session: string | null | undefined,
    paneId: string,
  ) => Promise<HerdrOpResult<HerdrServiceMapInfo>>;
  readonly onHerdrServiceMapEvent: (
    listener: (event: HerdrServiceMapInfo) => void,
  ) => () => void;
  readonly herdrServeCatalogGet: (
    hostId: string,
  ) => Promise<HerdrOpResult<HerdrServeCatalogInfo>>;
  readonly herdrServeCatalogRefresh: (
    hostId: string,
  ) => Promise<HerdrOpResult<HerdrServeCatalogInfo>>;
  /** Marks the pane seen so herdr agent_status transitions done → idle. */
  readonly herdrMarkPaneSeen: (
    hostId: string,
    session: string | null | undefined,
    paneId: string,
  ) => Promise<HerdrOpResult<{ readonly agentStatus?: string; readonly paneId: string }>>;
  readonly herdrCreateWorkspace: (
    hostId: string,
    session: string | null | undefined,
    input: { readonly cwd: string; readonly label?: string },
  ) => Promise<HerdrOpResult<{ readonly workspaceId: string; readonly tabId?: string; readonly paneId?: string; readonly terminalId?: string }>>;
  readonly herdrCreateTab: (
    hostId: string,
    session: string | null | undefined,
    input: { readonly workspaceId: string; readonly label?: string },
  ) => Promise<HerdrOpResult<{ readonly tabId: string; readonly paneId?: string; readonly terminalId?: string }>>;
  readonly herdrCreatePane: (
    hostId: string,
    session: string | null | undefined,
    input: { readonly paneId?: string; readonly direction?: "right" | "down"; readonly cwd?: string },
  ) => Promise<HerdrOpResult<{ readonly paneId: string; readonly terminalId?: string; readonly tabId?: string; readonly workspaceId?: string }>>;
  readonly herdrKillPane: (
    hostId: string,
    session: string | null | undefined,
    paneId: string,
  ) => Promise<HerdrOpResult<{ readonly closed: true }>>;
  readonly herdrKillTab: (
    hostId: string,
    session: string | null | undefined,
    tabId: string,
  ) => Promise<HerdrOpResult<{ readonly closed: true }>>;
  readonly herdrStreamOpen: (input: HerdrStreamOpenInput) => Promise<HerdrStreamOpenResult>;
  readonly herdrStreamInput: (streamId: string, dataBase64: string) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  /**
   * Stage a clipboard/dropped image on the herdr host (local write or ssh),
   * then paste the absolute path via stock `terminal.input`. No herdr forks.
   * `dataBase64` is raw image bytes (not a data URL). Cap 16 MiB.
   */
  readonly herdrStreamPasteImage: (
    streamId: string,
    extension: string,
    dataBase64: string,
  ) => Promise<{ readonly ok: boolean; readonly error?: string; readonly path?: string }>;
  readonly herdrStreamResize: (streamId: string, cols: number, rows: number) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  readonly herdrStreamScroll: (
    streamId: string,
    delta: number,
    at?: HerdrPointerCell,
  ) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  readonly herdrStreamClose: (streamId: string) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  readonly herdrObserveTouch: (input: HerdrObserveTouchInput) => Promise<{ readonly pooled: boolean }>;
  /** Retained observe frames for a terminal — preview paint without opening a stream. */
  readonly herdrObserveRetained: (terminalId: string) => Promise<HerdrRetainedPayload>;
  readonly onHerdrStreamEvent: (listener: (event: HerdrStreamEvent) => void) => () => void;
  readonly herdrMirrorState: () => Promise<ReadonlyArray<HerdrMirrorStateInfo>>;
  readonly onHerdrMirrorEvent: (listener: (event: HerdrMirrorEvent) => void) => () => void;
}

// --- demo/scripting engine (--vellum-demo only) ------------------------------
// Outside demo mode: demoState answers { active: false } and the other two
// answer ok:false — handlers are always registered, behavior is flag-gated.

export interface VellumDemoApi {
  readonly demoState: () => Promise<DemoStateInfo>;
  readonly demoCommand: (command: DemoCommand) => Promise<DemoCommandResult>;
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

export interface VellumBrowserApi {
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

// --- trusted-renderer browser automation -----------------------------------

export const BROWSER_AUTOMATION_HERDR_AGENTS = Object.freeze([
  "claude",
  "codex",
  "hermes",
  "kimi",
  "opencode",
] as const);

export type BrowserAutomationHerdrAgent =
  (typeof BROWSER_AUTOMATION_HERDR_AGENTS)[number];

/** Locator-only request. Scope, actions, TTL, origin, profile, and subject are main-owned. */
export type BrowserAutomationEnableInput =
  | {
      readonly kind: "hermes";
      readonly ref: NodeRefKey;
    }
  | {
      readonly kind: "herdr";
      readonly ref: NodeRefKey;
      readonly agent: BrowserAutomationHerdrAgent;
    };

export type BrowserAutomationSummary =
  | {
      readonly automationId: string;
      readonly kind: "hermes";
      readonly ref: NodeRefKey;
      readonly issuedAt: number;
      readonly expiresAt: number;
    }
  | {
      readonly automationId: string;
      readonly kind: "herdr";
      readonly ref: NodeRefKey;
      readonly agent: (typeof BROWSER_AUTOMATION_HERDR_AGENTS)[number];
      readonly issuedAt: number;
      readonly expiresAt: number;
    };

export type BrowserAutomationErrorCode =
  | "invalid"
  | "cancelled"
  | "capacity"
  | "delivery_failed"
  | "closed"
  | "not_found";

/**
 * Public automation results are intentionally message-free. Capability,
 * control-home, registry owner/principal/job/audit identifiers, and internal
 * errors remain in the main process.
 */
export type BrowserAutomationEnableResult =
  | { readonly ok: true; readonly data: BrowserAutomationSummary }
  | { readonly ok: false; readonly code: BrowserAutomationErrorCode };
export type BrowserAutomationListResult =
  | { readonly ok: true; readonly data: ReadonlyArray<BrowserAutomationSummary> }
  | { readonly ok: false; readonly code: BrowserAutomationErrorCode };
export type BrowserAutomationRevokeResult =
  | { readonly ok: true; readonly data: { readonly revoked: true } }
  | { readonly ok: false; readonly code: BrowserAutomationErrorCode };

export interface VellumBrowserAutomationApi {
  readonly browserAutomationEnable: (
    input: BrowserAutomationEnableInput,
  ) => Promise<BrowserAutomationEnableResult>;
  readonly browserAutomationList: () => Promise<BrowserAutomationListResult>;
  readonly browserAutomationRevoke: (
    automationId: string,
  ) => Promise<BrowserAutomationRevokeResult>;
}
