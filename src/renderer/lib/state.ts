import { observable } from "@legendapp/state";
import type { CanvasDoc } from "@shared/canvas";
import type { SnapshotState } from "@shared/entities";
import type { CanvasSummary, DigestResult } from "@shared/ipc";

export const EMPTY_DOC: CanvasDoc = { nodes: [], edges: [] };
export const EMPTY_SNAPSHOTS: SnapshotState = { bundles: [] };

// The document plane lives here as the single source of truth for persistence
// and derived graph state. React Flow keeps its own copy for smooth
// interaction; structural mutations bump `docVersion` to re-sync it.
export const state$ = observable({
  canvases: [] as ReadonlyArray<CanvasSummary>,
  canvasName: "",
  doc: EMPTY_DOC as CanvasDoc,
  // Incremented on every structural change (add/remove/edit/flag) and on
  // external reload — NOT on drag, which RF already reflects.
  docVersion: 0,
  snapshots: EMPTY_SNAPSHOTS as SnapshotState,
  digest: null as DigestResult | null,
  digestOpen: false,
  booting: true,
  error: "",
});
