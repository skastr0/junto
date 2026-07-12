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
  getSnapshots: "vellum:get-snapshots",
  refreshSnapshots: "vellum:refresh-snapshots",
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
  readonly source: "tower" | "quasar" | "booth";
  readonly key: string;
}

export interface VellumApi {
  readonly listCanvases: () => Promise<ReadonlyArray<CanvasSummary>>;
  readonly readCanvas: (name: string) => Promise<CanvasReadResult>;
  readonly writeCanvas: (name: string, doc: CanvasDoc) => Promise<void>;
  readonly createCanvas: (name: string) => Promise<CanvasReadResult>;
  readonly exportDigest: (name: string) => Promise<DigestResult>;
  readonly getSnapshots: () => Promise<SnapshotState>;
  readonly refreshSnapshots: (hints?: ReadonlyArray<BindingHint>) => Promise<SnapshotState>;
  readonly onCanvasChanged: (listener: (name: string) => void) => () => void;
  readonly onSnapshotsChanged: (listener: (state: SnapshotState) => void) => () => void;
}
