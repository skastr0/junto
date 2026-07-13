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
  exportDigest: "vellum:export-digest",
  generatePortfolio: "vellum:generate-portfolio",
  getSnapshots: "vellum:get-snapshots",
  refreshSnapshots: "vellum:refresh-snapshots",
  towerBrowse: "vellum:tower-browse",
  towerSearch: "vellum:tower-search",
  quasarSessions: "vellum:quasar-sessions",
  quasarSearch: "vellum:quasar-search",
  agentIdentity: "vellum:agent-identity",
  agentAvatar: "vellum:agent-avatar",
  agentMessage: "vellum:agent-message",
  // main -> renderer pushes
  canvasChanged: "vellum:canvas-changed",
  snapshotsChanged: "vellum:snapshots-changed",
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

export interface VellumApi {
  readonly listCanvases: () => Promise<ReadonlyArray<CanvasSummary>>;
  readonly readCanvas: (name: string) => Promise<CanvasReadResult>;
  readonly writeCanvas: (name: string, doc: CanvasDoc) => Promise<void>;
  readonly createCanvas: (name: string) => Promise<CanvasReadResult>;
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
  readonly quasarSessions: (quasarKey: string, limit?: number) => Promise<QuasarSessionsResult>;
  readonly quasarSearch: (query: string, quasarKey?: string) => Promise<QuasarSearchResult>;
  // Hermes fleet: identity enrichment, lazy avatar (data: URI), and messaging.
  readonly agentIdentity: (key: string) => Promise<AgentIdentity | null>;
  readonly agentAvatar: (key: string) => Promise<string | null>;
  readonly agentMessage: (key: string, text: string) => Promise<AgentReply>;
  readonly onCanvasChanged: (listener: (name: string) => void) => () => void;
  readonly onSnapshotsChanged: (listener: (state: SnapshotState) => void) => () => void;
}
