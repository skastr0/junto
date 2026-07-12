import { observable } from "@legendapp/state";
import type { CanvasDoc, EtherEdgeKind, EtherFlag } from "@shared/canvas";
import type { EntitySource, SnapshotState } from "@shared/entities";
import type { CanvasSummary, DigestResult } from "@shared/ipc";

export const EMPTY_DOC: CanvasDoc = { nodes: [], edges: [] };
export const EMPTY_SNAPSHOTS: SnapshotState = { bundles: [] };

// The document plane lives here as the single source of truth for persistence
// and derived graph state. React Flow keeps its own copy for smooth
// interaction; structural mutations bump `docVersion` to re-sync it.
export const state$ = observable({
  canvases: [] as ReadonlyArray<CanvasSummary>,
  canvasName: "",
  canvasLoading: false,
  searchQuery: "",
  edgeFilter: "" as EtherEdgeKind | "",
  sourceFilter: "" as EntitySource | "",
  flagFilter: "" as EtherFlag | "",
  viewMode: "field" as "field" | "manifest",
  editNodeId: "",
  selectedNodeId: "",
  selectedEdgeId: "",
  focusNodeId: "",
  doc: EMPTY_DOC as CanvasDoc,
  // Incremented on every structural change (add/remove/edit/flag) and on
  // external reload — NOT on drag, which RF already reflects.
  docVersion: 0,
  snapshots: EMPTY_SNAPSHOTS as SnapshotState,
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

const toggleFilterValue = <T extends string>(current: T | "", value: T, set: (next: T | "") => void): void => {
  set(current === value ? "" : value);
  state$.selectedNodeId.set("");
  state$.selectedEdgeId.set("");
};

export const toggleSourceFilter = (source: EntitySource): void => {
  toggleFilterValue(state$.sourceFilter.peek(), source, (next) => state$.sourceFilter.set(next));
};

export const toggleFlagFilter = (flag: EtherFlag): void => {
  toggleFilterValue(state$.flagFilter.peek(), flag, (next) => state$.flagFilter.set(next));
};

export const clearGraphFilters = (): void => {
  state$.edgeFilter.set("");
  state$.sourceFilter.set("");
  state$.flagFilter.set("");
  state$.selectedNodeId.set("");
  state$.selectedEdgeId.set("");
};
