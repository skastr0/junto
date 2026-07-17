import { observable } from "@legendapp/state";
import type { CanvasDoc, EtherEdgeKind, EtherFlag } from "@shared/canvas";
import type { SnapshotState } from "@shared/entities";
import type { CanvasSummary, DigestResult } from "@shared/ipc";
import type { UsageState } from "@shared/usage";

export const EMPTY_DOC: CanvasDoc = { nodes: [], edges: [] };
export const EMPTY_SNAPSHOTS: SnapshotState = { bundles: [] };
export const EMPTY_USAGE: UsageState = { snapshots: [] };

// The document plane lives here as the single source of truth for persistence
// and derived graph state. React Flow keeps its own copy for smooth
// interaction; structural mutations bump `docVersion` to re-sync it.
export const state$ = observable({
  canvases: [] as ReadonlyArray<CanvasSummary>,
  canvasName: "",
  canvasLoading: false,
  searchQuery: "",
  edgeFilter: "" as EtherEdgeKind | "",
  flagFilter: "" as EtherFlag | "",
  editNodeId: "",
  selectedNodeId: "",
  // React Flow multi-select set, mirrored so hotkeys (Ctrl+1–9) and the
  // command card can read it. Presentational; never persisted.
  selectedNodeIds: [] as ReadonlyArray<string>,
  selectedEdgeId: "",
  focusNodeId: "",
  // Presentational hotbar order of region (group) ids for slots 1–9.
  // App-local only — never written into the .canvas document.
  regionSlotOrder: [] as ReadonlyArray<string>,
  doc: EMPTY_DOC as CanvasDoc,
  // Incremented on every structural change (add/remove/edit/flag) and on
  // external reload — NOT on drag, which RF already reflects.
  docVersion: 0,
  snapshots: EMPTY_SNAPSHOTS as SnapshotState,
  // Provider usage plane (codexbar). Fail-open empty until first push/boot load.
  usage: EMPTY_USAGE as UsageState,
  digest: null as DigestResult | null,
  digestOpen: false,
  exporting: false,
  booting: true,
  generating: false,
  refreshing: false,
  saveState: "saved" as "saved" | "saving" | "error",
  canUndo: false,
  canRedo: false,
  error: "",
});

export const toggleFlagFilter = (flag: EtherFlag): void => {
  const current = state$.flagFilter.peek();
  state$.flagFilter.set(current === flag ? "" : flag);
  state$.selectedNodeId.set("");
  state$.selectedNodeIds.set([]);
  state$.selectedEdgeId.set("");
};

export const clearGraphFilters = (): void => {
  state$.edgeFilter.set("");
  state$.flagFilter.set("");
  state$.selectedNodeId.set("");
  state$.selectedNodeIds.set([]);
  state$.selectedEdgeId.set("");
};

/** Clear canvas selection (node + multi + edge). */
export const clearSelection = (): void => {
  state$.selectedNodeId.set("");
  state$.selectedNodeIds.set([]);
  state$.selectedEdgeId.set("");
};
