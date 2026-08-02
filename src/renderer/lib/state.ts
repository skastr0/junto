import { batch, observable } from "@legendapp/state";
import type { CanvasDoc, EtherEdgeKind, EtherFlag } from "@shared/canvas";
import type { SnapshotState } from "@shared/entities";
import type { CanvasSummary, DigestResult, DiscoveredPeer } from "@shared/ipc";
import type { RemoteHost } from "@shared/remote-hosts";
import { defaultSettings, type Settings } from "@shared/settings";
import type { UsageState } from "@shared/usage";
import type { ActorRef } from "@shared/work-protocol";
import type { FleetProbeState } from "./fleet-state";

export const EMPTY_DOC: CanvasDoc = { nodes: [], edges: [] };
export const EMPTY_SNAPSHOTS: SnapshotState = { bundles: [] };
export const EMPTY_USAGE: UsageState = { snapshots: [] };
export const EMPTY_SETTINGS: Settings = defaultSettings();

// The renderer holds the live document projection and derived graph state.
// SQLite authority remains in main. React Flow keeps its own copy for smooth
// interaction; structural mutations bump `docVersion` to re-sync it.
export const state$ = observable({
  canvases: [] as ReadonlyArray<CanvasSummary>,
  canvasName: "",
  canvasLoading: false,
  searchQuery: "",
  edgeFilter: "" as EtherEdgeKind | "",
  flagFilter: "" as EtherFlag | "",
  editNodeId: "",
  // One-shot: open region folder-paths modal for this group id (cleared on consume).
  regionPathsNodeId: "",
  selectedNodeId: "",
  // React Flow multi-select set, mirrored so hotkeys (Ctrl+1–9) and the
  // command card can read it. Presentational; never persisted.
  selectedNodeIds: [] as ReadonlyArray<string>,
  selectedEdgeId: "",
  // One-shot request used by canvas gestures that should open the selected
  // edge's fields directly (rather than making the operator find the fields
  // key in the relation strip).
  edgeSettingsRequestId: "",
  // Presentational connection-focus target. Unlike focusNodeId (a one-shot
  // camera request), this stays set while the operator inspects one node's
  // neighborhood and is never persisted to the canvas document.
  connectionFocusNodeId: "",
  focusNodeId: "",
  // Presentational hotbar order of any node ids for slots 1–9.
  // Fully controlled: empty until operator assigns (⌘1–9 / slot cue).
  // App-local only — never written into the authorial canvas document.
  regionSlotOrder: [] as ReadonlyArray<string>,
  // Per-node severity for minimap dots (from region rollups). App-local.
  regionSeverityByNodeId: {} as Readonly<Record<string, string>>,
  doc: EMPTY_DOC as CanvasDoc,
  // Compiled execution identities for actor nodes in the open canvas.
  // Projection-only: never written back into the authorial document.
  actorRefs: [] as ReadonlyArray<ActorRef>,
  // Incremented on every structural change (add/remove/edit/flag) and on
  // external reload — NOT on drag, which RF already reflects.
  docVersion: 0,
  // Bumped on every commitDoc (including position-only drags) so geometric
  // region membership can re-poll without forcing a React Flow rebuild.
  docEpoch: 0,
  snapshots: EMPTY_SNAPSHOTS as SnapshotState,
  // Provider usage plane (beta: codexbar). Fail-open empty until first quotas.
  usage: EMPTY_USAGE as UsageState,
  // User settings document (main owns the SQLite row; renderer holds a live projection).
  settings: EMPTY_SETTINGS as Settings,
  settingsOpen: false,
  settingsLoading: false,
  /** Developer logs explorer (gated by advanced.logsExplorer). */
  observabilityOpen: false,
  settingsError: "",
  // Fleet overlay plane: enrolled hosts, discovered Tailscale peers, and
  // per-host reachability probes. Mirrors the settings plane pattern.
  fleetOpen: false,
  fleetHosts: [] as ReadonlyArray<RemoteHost>,
  fleetPeers: [] as ReadonlyArray<DiscoveredPeer>,
  fleetLoading: false,
  fleetProbe: {} as Record<string, FleetProbeState>,
  digest: null as DigestResult | null,
  digestOpen: false,
  exporting: false,
  booting: true,
  generating: false,
  saveState: "saved" as "saved" | "saving" | "error",
  canUndo: false,
  canRedo: false,
  error: "",
});

export const toggleFlagFilter = (flag: EtherFlag): void => {
  batch(() => {
    const current = state$.flagFilter.peek();
    state$.flagFilter.set(current === flag ? "" : flag);
    state$.selectedNodeId.set("");
    state$.selectedNodeIds.set([]);
    state$.selectedEdgeId.set("");
    state$.edgeSettingsRequestId.set("");
    state$.connectionFocusNodeId.set("");
  });
};

export const clearGraphFilters = (): void => {
  batch(() => {
    state$.edgeFilter.set("");
    state$.flagFilter.set("");
    state$.selectedNodeId.set("");
    state$.selectedNodeIds.set([]);
    state$.selectedEdgeId.set("");
    state$.edgeSettingsRequestId.set("");
    state$.connectionFocusNodeId.set("");
  });
};

/** Clear canvas selection (node + multi + edge). */
export const clearSelection = (): void => {
  batch(() => {
    state$.selectedNodeId.set("");
    state$.selectedNodeIds.set([]);
    state$.selectedEdgeId.set("");
    state$.edgeSettingsRequestId.set("");
    state$.connectionFocusNodeId.set("");
  });
};

/** Toggle the presentational focus cone for one node's direct connections. */
export const toggleConnectionFocus = (nodeId: string): void => {
  state$.connectionFocusNodeId.set(
    state$.connectionFocusNodeId.peek() === nodeId ? "" : nodeId,
  );
};
