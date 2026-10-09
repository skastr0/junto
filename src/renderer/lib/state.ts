import { batch, observable } from "@legendapp/state";
import type { WirePhase } from "@shared/model/wire";
import type { SnapshotState } from "@shared/entities";
import type { CanvasSummary, DigestResult, DiscoveredPeer } from "@shared/ipc";
import type { RegionRollup } from "@shared/region-rollup";
import type { RemoteHost } from "@shared/remote-hosts";
import { defaultSettings, type Settings } from "@shared/settings";
import type { UsageState } from "@shared/usage";
import type { ActorRef } from "@shared/work-protocol";
import type { FleetProbeState } from "./fleet-state";
import type { HotbarSlot } from "./hotbar-slots";

export const EMPTY_SNAPSHOTS: SnapshotState = { bundles: [] };
export const EMPTY_USAGE: UsageState = { snapshots: [] };
export const EMPTY_SETTINGS: Settings = defaultSettings();

// What the window itself holds: what is selected, focused and shown. The
// canvas is in the node store (model-store.ts), not here. React Flow keeps
// its own copy for smooth interaction; `docVersion` steps to re-sync it.
export const state$ = observable({
  canvases: [] as ReadonlyArray<CanvasSummary>,
  canvasName: "",
  canvasLoading: false,
  /** Node palette (add canvas item) — shared by the field trigger and the
   * command bar action. */
  nodePaletteOpen: false,
  /** One-shot request: bump to fit the readable view (Canvas consumes). */
  fitViewRequest: 0,
  /** One-shot request: canvas name to open (App consumes + clears). */
  canvasOpenRequest: "",
  edgeFilter: "" as WirePhase | "",
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
   * Operator command groups past slot 9, by canvas name: shown in the top
   * bar without a hotkey. App-local for the session, never authorial.
   * @see command-groups.ts
   */
  extraCommandGroups: {} as Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>>,
  /**
   * @deprecated Prefer hotbarSlots. Dense fixed-only ids kept briefly for
   * any remaining readers; updated when hotbar recompute runs.
   */
  regionSlotOrder: [] as ReadonlyArray<string>,
  // Per-node severity for minimap dots (from region rollups). App-local.
  regionSeverityByNodeId: {} as Readonly<Record<string, string>>,
  // Per-region member tallies (from region rollups), for the overview tier.
  regionCountsByNodeId: {} as Readonly<Record<string, RegionRollup["counts"]>>,
  // Compiled execution identities for actor nodes in the open canvas, as main
  // announces them. Never written back.
  actorRefs: [] as ReadonlyArray<ActorRef>,
  // Stepped whenever the open canvas changes in the node store, and when a
  // canvas is opened.
  docVersion: 0,
  // Stepped with it. A delete in progress reads it to know the canvas is
  // still the one the operator was asked about.
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
  /** The machine list as main last reported it (lib/machines.ts). Empty when
      the machines surface is off; this machine's name comes from settings. */
  machines: [] as ReadonlyArray<RemoteHost>,
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

export const clearGraphFilters = (): void => {
  batch(() => {
    state$.edgeFilter.set("");
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

  // The same cards selected is not a new selection. React Flow reports its
  // selection again whenever its nodes are reordered (a drop brings the cards
  // it moved to the front), with the same ids in a new array and a new order;
  // writing that would wake every reader of the selection for nothing. The
  // list already held is kept, in the order the operator selected in.
  const held = state$.selectedNodeIds.peek();
  const sameCards = held.length === nodeIds.length && nodeIds.every((id) => held.includes(id));

  batch(() => {
    state$.selectedNodeId.set(nodeId);
    if (!sameCards) state$.selectedNodeIds.set(nodeIds);
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
