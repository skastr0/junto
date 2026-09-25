import { batch, observable } from "@legendapp/state";
import type { CanvasDoc, EtherEdgeKind, EtherFlag } from "@shared/canvas";
import type { SnapshotState } from "@shared/entities";
import type { CanvasSummary, DigestResult, DiscoveredPeer } from "@shared/ipc";
import type { RemoteHost } from "@shared/remote-hosts";
import { defaultSettings, type Settings } from "@shared/settings";
import type { UsageState } from "@shared/usage";
import type { ActorRef } from "@shared/work-protocol";
import type { FleetProbeState } from "./fleet-state";
import type { HotbarSlot } from "./hotbar-slots";

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
  commandBarOpen: false,
  /** Node palette (add canvas item) — shared by the field trigger and the
   * command bar action. */
  nodePaletteOpen: false,
  /** One-shot request: bump to fit the readable view (Canvas consumes). */
  fitViewRequest: 0,
  /** One-shot request: canvas name to open (App consumes + clears). */
  canvasOpenRequest: "",
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
  // Presentational connection-focus target. Unlike focusNodeId (a one-shot
  // camera request), this stays set while the operator inspects one node's
  // neighborhood and is never persisted to the canvas document.
  connectionFocusNodeId: "",
  focusNodeId: "",
  // One-shot camera request to frame several nodes together (a recalled
  // command group). Canvas selects them, fits them, then clears it.
  focusNodeIds: [] as ReadonlyArray<string>,
  /**
   * Presentational hotbar (slots 1–9): empty | fixed | group | leased |
   * evicted (idle soft-hold). App-local only — never authorial.
   * @see hotbar-slots.ts, command-groups.ts
   */
  hotbarSlots: Array.from({ length: 9 }, () => ({
    kind: "empty" as const,
  })) as ReadonlyArray<HotbarSlot>,
  /** Most-recently-active node ids (front = newest) for opportunistic leases. */
  hotbarActiveMru: [] as ReadonlyArray<string>,
  /**
   * @deprecated Prefer hotbarSlots. Dense fixed-only ids kept briefly for
   * any remaining readers; updated when hotbar recompute runs.
   */
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
  // Provider usage plane (native sources). Fail-open empty until first quotas.
  usage: EMPTY_USAGE as UsageState,
  // User settings document (main owns the SQLite row; renderer holds a live projection).
  settings: EMPTY_SETTINGS as Settings,
  settingsOpen: false,
  settingsLoading: false,
  /** True once the durable settings row has hydrated (not the default stand-in). */
  settingsReady: false,
  /** First-run introduction reopened on request (help map, Settings). */
  introOpen: false,
  /** Finished or skipped this session, so a failed seen-flag write never loops. */
  introDismissed: false,
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
    state$.connectionFocusNodeId.set("");
  });
};

/** Clear canvas selection (node + multi + edge). */
export const clearSelection = (): void => {
  batch(() => {
    state$.selectedNodeId.set("");
    state$.selectedNodeIds.set([]);
    state$.selectedEdgeId.set("");
    state$.connectionFocusNodeId.set("");
  });
};

type SelectionReplacement = {
  readonly nodeId?: string;
  readonly nodeIds?: ReadonlyArray<string>;
  readonly edgeId?: string;
};

/**
 * Low-level atomic replacement for the mirrored React Flow selection.
 * Normal UI actions should prefer selectNode/selectNodes/selectEdge.
 */
export const replaceSelection = ({
  nodeId: requestedNodeId = "",
  nodeIds: requestedNodeIds = [],
  edgeId: requestedEdgeId = "",
}: SelectionReplacement): void => {
  const nodeIds = requestedNodeIds.length === 0 && requestedNodeId
    ? [requestedNodeId]
    : requestedNodeIds;
  const nodeId = nodeIds.length === 1
    ? nodeIds[0] ?? ""
    : requestedNodeId && nodeIds.includes(requestedNodeId)
      ? requestedNodeId
      : "";
  const edgeId = nodeIds.length === 0 ? requestedEdgeId : "";

  batch(() => {
    state$.selectedNodeId.set(nodeId);
    state$.selectedNodeIds.set(nodeIds);
    state$.selectedEdgeId.set(edgeId);
  });
};

/** Select one node. */
export const selectNode = (nodeId: string): void => {
  replaceSelection({ nodeId });
};

/** Select a canonical node set. */
export const selectNodes = (nodeIds: ReadonlyArray<string>): void => {
  replaceSelection({ nodeIds: [...new Set(nodeIds.filter(Boolean))] });
};

/**
 * Replace every node selection with one edge selection, atomically. An edge
 * has no settings surface to request: its verb, endpoints, and delete all read
 * off the RTS bottom bar from the selection alone.
 */
export const selectEdge = (edgeId: string): void => {
  batch(() => {
    replaceSelection({ edgeId });
    state$.connectionFocusNodeId.set("");
  });
};

/** Remove deleted nodes from both Legend selection channels. */
export const removeNodesFromSelection = (
  removedNodeIds: ReadonlySet<string>,
): void => {
  if (removedNodeIds.size === 0) return;
  const currentNodeIds = state$.selectedNodeIds.peek();
  const selectedNodeId = state$.selectedNodeId.peek();
  const candidates = selectedNodeId && !currentNodeIds.includes(selectedNodeId)
    ? [...currentNodeIds, selectedNodeId]
    : currentNodeIds;
  const nextNodeIds = candidates.filter((id) => !removedNodeIds.has(id));
  if (nextNodeIds.length === candidates.length) return;

  selectNodes(nextNodeIds);
};

/** Clear an edge selection only when that edge was removed. */
export const removeEdgesFromSelection = (
  removedEdgeIds: ReadonlySet<string>,
): void => {
  const selectedEdgeId = state$.selectedEdgeId.peek();
  if (!selectedEdgeId || !removedEdgeIds.has(selectedEdgeId)) return;
  replaceSelection({
    nodeId: state$.selectedNodeId.peek(),
    nodeIds: state$.selectedNodeIds.peek(),
  });
};

/** Toggle the presentational focus cone for one node's direct connections. */
export const toggleConnectionFocus = (nodeId: string): void => {
  state$.connectionFocusNodeId.set(
    state$.connectionFocusNodeId.peek() === nodeId ? "" : nodeId,
  );
};
