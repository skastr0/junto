import type { DirectoryEntry, DoctorReport, FolderSnapshot, ServiceCheck } from "./contracts";
import type { CanvasDoc } from "./canvas";
import type { SnapshotState } from "./entities";

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
  exportDigest: "vellum:export-digest",
  generatePortfolio: "vellum:generate-portfolio",
  getSnapshots: "vellum:get-snapshots",
  refreshSnapshots: "vellum:refresh-snapshots",
  towerBrowse: "vellum:tower-browse",
  towerSearch: "vellum:tower-search",
  towerGlyphRead: "vellum:tower-glyph-read",
  towerSignalRead: "vellum:tower-signal-read",
  towerDispatches: "vellum:tower-dispatches",
  quasarSessions: "vellum:quasar-sessions",
  quasarSearch: "vellum:quasar-search",
  quasarSessionDetail: "vellum:quasar-session-detail",
  towerCommentGlyph: "vellum:tower-comment-glyph",
  towerCommentSignal: "vellum:tower-comment-signal",
  boothDrafts: "vellum:booth-drafts",
  boothDraftRead: "vellum:booth-draft-read",
  boothRequests: "vellum:booth-requests",
  boothReview: "vellum:booth-review",
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
  // main -> renderer pushes
  canvasChanged: "vellum:canvas-changed",
  snapshotsChanged: "vellum:snapshots-changed",
  chatEvent: "vellum:chat-event",
  kernelChanged: "vellum:kernel-changed",
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

export interface KernelSnapshot {
  readonly canvases: Readonly<
    Record<
      string,
      {
        readonly watchers: Record<string, WatcherRuntimeState>;
        readonly armed: Record<string, boolean>;
        readonly nextFire: Record<string, number>;
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

// --- source browsing (read-only detail views; never canvas nodes) ----------

export interface TowerGlyphRow {
  readonly glyphId: string;
  readonly orbit: string;
  readonly title: string;
  readonly state: string; // backlog|exploring|committed|building|reviewing|done|abandoned
  readonly updatedAt: number; // epoch ms
}

export interface TowerSignalRow {
  readonly signalId: string;
  readonly orbit: string;
  readonly status: string; // inbox|claimed|consumed|dead
  readonly kind: string;
  readonly summary: string;
  readonly priority?: string; // low|normal|high|urgent
  readonly updatedAt: number; // epoch ms
}

export interface TowerBrowseResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly glyphs: ReadonlyArray<TowerGlyphRow>;
  readonly signals: ReadonlyArray<TowerSignalRow>;
  // Additive: set when SOME (but not all) of the 5 fanned-out orbit requests
  // failed — glyphs/signals only cover the orbits that succeeded, so this
  // result under-reports what a healthy gateway would return. Consumers
  // that make edge-fire decisions off glyph counts (the kernel's
  // glyphs_done/glyphs_entered_state watchers) must never treat a partial
  // read as authoritative — absent (or false) means every orbit answered.
  readonly partial?: boolean;
}

export interface TowerSearchMatch {
  readonly family: string; // glyphs|signals|projects|dispatches|chatter|comments
  readonly title: string;
  readonly summary?: string;
  readonly projectKey: string;
  readonly orbit?: string;
  readonly glyphId?: string;
  readonly signalId?: string;
  readonly state?: string;
  readonly status?: string;
  readonly score: number;
}

export interface TowerSearchResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly matches: ReadonlyArray<TowerSearchMatch>;
}

// Full glyph detail for the reader modal (GET /api/glyphs/read).
export interface TowerGlyphDetail {
  readonly glyphId: string;
  readonly orbit: string;
  readonly title: string;
  readonly state: string;
  readonly content: string; // raw markdown body
  readonly commentsTotal: number;
  readonly latestComment?: string;
  readonly dependencies: ReadonlyArray<string>;
  readonly dependents: ReadonlyArray<string>;
  readonly updatedAt: number;
}

export interface TowerGlyphReadResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly glyph?: TowerGlyphDetail;
}

// Full signal detail for the reader modal (GET /api/signals/read).
export interface TowerSignalDetail {
  readonly signalId: string;
  readonly orbit: string;
  readonly status: string;
  readonly kind: string;
  readonly summary: string;
  readonly priority?: string;
  readonly payloadJson?: string; // pretty-printed, size-capped
  readonly sourceName?: string;
  readonly consumedBy?: string;
  readonly consumptionSummary?: string;
  readonly updatedAt: number;
}

export interface TowerSignalReadResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly signal?: TowerSignalDetail;
}

// Dispatches, if the live gateway exposes a browse route for them; adapters
// probe and report ok:false error:"unsupported" when it does not.
export interface TowerDispatchRow {
  readonly id: string;
  readonly orbit?: string;
  readonly title: string;
  readonly status?: string;
  readonly updatedAt: number;
}

export interface TowerDispatchesResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly dispatches: ReadonlyArray<TowerDispatchRow>;
}

export interface QuasarSessionRow {
  readonly sessionId: string;
  readonly title?: string; // null for claude/codex/antigravity — UI needs a fallback
  readonly provider: string;
  readonly agentName?: string;
  readonly messageCount: number;
  readonly toolCallCount: number;
  readonly updatedAt?: string; // ISO, frequently absent
}

export interface QuasarSessionsResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly sessions: ReadonlyArray<QuasarSessionRow>;
}

export interface QuasarSearchMatch {
  readonly sessionId: string;
  readonly role: string;
  readonly provider: string;
  readonly text: string; // trimmed excerpt
  readonly score: number;
}

export interface QuasarSearchResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly matches: ReadonlyArray<QuasarSearchMatch>;
}

// Session summary for the session modal: bookends + counts derived from
// `quasar messages` (per-message ts is reliable even when session dates are
// null for a provider).
export interface QuasarSessionDetail {
  readonly sessionId: string;
  readonly provider: string;
  readonly title?: string;
  readonly messageCount: number;
  readonly toolCallCount: number;
  readonly firstUser?: string; // trimmed first user message
  readonly lastAssistant?: string; // trimmed final assistant message
  readonly startedAt?: string; // ISO, min message ts
  readonly endedAt?: string; // ISO, max message ts
  readonly topTools?: ReadonlyArray<string>; // most-used tool names, ≤3
}

export interface QuasarSessionDetailResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly detail?: QuasarSessionDetail;
}

// --- source mutations (deliberate, narrow writes) ---------------------------
// The adapter plane stays read-only except for these explicit, user-initiated
// acts: commenting on tower glyphs/signals and booth review verdicts.

export interface SourceWriteResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface BoothDraftRow {
  readonly id: string;
  readonly title: string;
  readonly status?: string;
  readonly kind?: string;
  readonly assetType?: string;
  readonly agentName?: string;
  readonly updatedAt?: string;
}

export interface BoothDraftsResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly drafts: ReadonlyArray<BoothDraftRow>;
}

// One review event on a draft's thread — comments and verdicts share the
// same timeline (that IS booth's review model: a verdict is an event).
export interface BoothReviewEventRow {
  readonly id: string;
  readonly eventType: string; // comment|approve|reject|request_revision
  readonly actor: string;
  readonly body?: string;
  readonly createdAt: number; // epoch ms
}

// Full draft detail for the reader modal (GET /api/drafts/read): the draft,
// its media asset (URLs made absolute in main — the renderer never learns
// how booth's base url resolves), and the complete review thread.
export interface BoothDraftDetail {
  readonly id: string;
  readonly projectKey: string;
  readonly title: string;
  readonly status: string;
  readonly mediaKind: string; // image|video|copy|post|carousel|ad_unit|other
  readonly assetType: string;
  readonly channel?: string;
  readonly placement?: string;
  readonly agentName?: string;
  readonly bodyText?: string;
  readonly captionText?: string;
  readonly mediaUrl?: string; // absolute; unauthenticated GET, renderer-loadable
  readonly thumbnailUrl?: string; // absolute
  readonly mimeType?: string;
  readonly createdAt: number; // epoch ms
  readonly updatedAt: number; // epoch ms
  readonly reviewEvents: ReadonlyArray<BoothReviewEventRow>;
}

export interface BoothDraftReadResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly detail?: BoothDraftDetail;
}

// A creative request (production ask) — the cycle's entry point.
export interface BoothRequestRow {
  readonly id: string;
  readonly title: string;
  readonly status: string; // open|in_progress|in_review|approved|closed|archived
  readonly assetType: string;
  readonly briefSummary: string;
  readonly requester?: string;
  readonly updatedAt: number; // epoch ms
}

export interface BoothRequestsResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly requests: ReadonlyArray<BoothRequestRow>;
}

export type BoothReviewAction = "approve" | "reject" | "comment" | "request_revision";

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
  readonly writeCanvas: (name: string, doc: CanvasDoc) => Promise<void>;
  readonly createCanvas: (name: string) => Promise<CanvasReadResult>;
  readonly deleteCanvas: (name: string) => Promise<{ name: string }>;
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
  // Source browsing (read-only; feeds inspector detail views, never nodes).
  readonly towerBrowse: (projectKey: string) => Promise<TowerBrowseResult>;
  readonly towerSearch: (query: string, projectKey?: string) => Promise<TowerSearchResult>;
  readonly towerGlyphRead: (projectKey: string, orbit: string, glyphId: string) => Promise<TowerGlyphReadResult>;
  readonly towerSignalRead: (projectKey: string, orbit: string, signalId: string) => Promise<TowerSignalReadResult>;
  readonly towerDispatches: (projectKey: string) => Promise<TowerDispatchesResult>;
  readonly quasarSessions: (quasarKey: string, limit?: number) => Promise<QuasarSessionsResult>;
  readonly quasarSearch: (query: string, quasarKey?: string) => Promise<QuasarSearchResult>;
  readonly quasarSessionDetail: (sessionId: string) => Promise<QuasarSessionDetailResult>;
  // Deliberate writes.
  readonly towerCommentGlyph: (projectKey: string, orbit: string, glyphId: string, body: string) => Promise<SourceWriteResult>;
  readonly towerCommentSignal: (projectKey: string, orbit: string, signalId: string, body: string) => Promise<SourceWriteResult>;
  readonly boothDrafts: (projectKey: string) => Promise<BoothDraftsResult>;
  readonly boothDraftRead: (draftId: string) => Promise<BoothDraftReadResult>;
  readonly boothRequests: (projectKey: string) => Promise<BoothRequestsResult>;
  readonly boothReview: (projectKey: string, draftId: string, action: BoothReviewAction, body?: string) => Promise<SourceWriteResult>;
  // Hermes fleet: identity enrichment, lazy avatar (data: URI), and messaging.
  readonly agentIdentity: (key: string) => Promise<AgentIdentity | null>;
  readonly agentAvatar: (key: string) => Promise<string | null>;
  readonly agentMessage: (key: string, text: string) => Promise<AgentReply>;
  // Kernel state and control (headless kernel in main process).
  readonly getKernelState: () => Promise<KernelSnapshot>;
  readonly armRegion: (canvasName: string, regionId: string, armed: boolean) => Promise<ArmRegionResult>;
  readonly pulseRegion: (canvasName: string, regionId: string, opts?: unknown) => Promise<void>;
  readonly onCanvasChanged: (listener: (name: string) => void) => () => void;
  readonly onSnapshotsChanged: (listener: (state: SnapshotState) => void) => () => void;
  readonly onKernelChanged: (listener: (snapshot: KernelSnapshot) => void) => () => void;
}

// The attached-chat surface is declared separately and merged into the
// preload bridge alongside VellumApi.
export interface VellumChatApi extends ChatApi {}
