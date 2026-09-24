import { batch } from "@legendapp/state";
import type { EtherEdgeKind, EtherFlag } from "@shared/canvas";
import { formatNodeRef } from "@shared/node-ref";
import {
  CircleSlash,
  Copy,
  Flag,
  Layers,
  Maximize,
  Pause,
  Play,
  Plus,
  ScrollText,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { isCommandCenterAuthoring } from "./canvas-boot";
import { factoryPause$, toggleFactoryPause } from "./factory-pause";
import { clearSelection, state$, toggleFlagFilter } from "./state";
import { openSettings } from "./settings-state";

/**
 * Command bar quick-actions catalog.
 *
 * Declarative entries that re-expose existing renderer commands only — the
 * bar never grants new reach. Entries are rebuilt per palette open so labels
 * reflect live state (pause switch, filter chips, open canvases, selection).
 */

export type CommandBarMode = "nodes" | "actions";

export interface CommandBarAction {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: LucideIcon;
  /** Existing hotkey chip where the surface already documents one. */
  readonly hotkey?: string;
  readonly run: () => void;
}

/** ">" prefix forces actions mode (VS Code convention); otherwise the tab
 * toggle decides. */
export const commandBarMode = (
  query: string,
  tabMode: CommandBarMode,
): CommandBarMode => (query.startsWith(">") ? "actions" : tabMode);

/** Search term for actions mode: strip the ">" prefix when present. */
export const commandBarActionQuery = (query: string): string =>
  (query.startsWith(">") ? query.slice(1) : query).trim().toLowerCase();

/** Filter the catalog: label and detail both match. Empty query = full catalog. */
export const filterCommandBarActions = (
  actions: ReadonlyArray<CommandBarAction>,
  query: string,
): ReadonlyArray<CommandBarAction> => {
  const q = commandBarActionQuery(query);
  if (!q) return actions;
  return actions.filter(
    (action) =>
      action.label.toLowerCase().includes(q) ||
      action.detail.toLowerCase().includes(q),
  );
};

const FLAG_CYCLE: ReadonlyArray<EtherFlag> = ["blocker", "parked", "attention"];

const DIGEST_UNAVAILABLE = "Canvas digest is unavailable.";
const DIGEST_FAILED = "Canvas digest failed; the panel did not open.";

const digestErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim()
    ? error.message
    : DIGEST_FAILED;

/** Open the digest for the named canvas. Late results after a switch are dropped. */
export const openCanvasDigest = async (canvasName: string): Promise<void> => {
  try {
    const result = await window.junto?.exportDigest(canvasName);
    if (state$.canvasName.peek() !== canvasName) return;
    if (result == null) {
      state$.error.set(DIGEST_UNAVAILABLE);
      return;
    }
    batch(() => {
      state$.error.set("");
      state$.digest.set(result);
      state$.digestOpen.set(true);
    });
  } catch (error) {
    if (state$.canvasName.peek() !== canvasName) return;
    state$.error.set(digestErrorMessage(error));
  }
};

const copySelectedNodeRef = async (): Promise<void> => {
  const nodeId = state$.selectedNodeId.peek();
  const canvasName = state$.canvasName.peek();
  if (!nodeId || !canvasName) return;
  const ref = formatNodeRef({ canvasName, nodeId });
  try {
    await navigator.clipboard?.writeText(ref);
  } catch {
    // Clipboard unavailable: the RTS card is the fallback surface.
  }
};

const cycleEdgeFilter = (): void => {
  const current = state$.edgeFilter.peek();
  const next: EtherEdgeKind | "" =
    current === "" ? "blocks" : current === "blocks" ? "relates" : "";
  state$.edgeFilter.set(next);
};

export const buildCommandBarActions = (): ReadonlyArray<CommandBarAction> => {
  const canvasName = state$.canvasName.peek();
  const authoring = isCommandCenterAuthoring(state$.settings.station.role.peek());
  const pauseState = factoryPause$.state.peek();
  const playing = Boolean(pauseState?.playing);
  const edgeFilter = state$.edgeFilter.peek();
  const activeFlag = state$.flagFilter.peek();
  const selectedNodeId = state$.selectedNodeId.peek();
  const actions: CommandBarAction[] = [];

  if (authoring && pauseState) {
    actions.push({
      id: "factory-pause",
      label: playing ? "Pause canvas" : "Play canvas",
      detail: playing
        ? "Stop cron, relay, and agent delivery on this canvas"
        : "Start cron, relay, and agent delivery on this canvas",
      icon: playing ? Pause : Play,
      run: () => toggleFactoryPause(canvasName),
    });
  }

  if (authoring) {
    actions.push({
      id: "add-item",
      label: "Add canvas item",
      detail: "Open the node palette",
      icon: Plus,
      run: () => state$.nodePaletteOpen.set(true),
    });
  }

  actions.push({
    id: "open-settings",
    label: "Open settings",
    detail: "Station, terminal, and theme settings",
    icon: Settings2,
    run: () => openSettings(),
  });

  actions.push({
    id: "open-digest",
    label: "Open canvas digest",
    detail: "Deterministic text projection of the board",
    icon: ScrollText,
    run: () => void openCanvasDigest(canvasName),
  });

  // One entry per other canvas — switching stays a one-keypress jump.
  for (const summary of state$.canvases.peek()) {
    if (summary.name === canvasName) continue;
    actions.push({
      id: `open-canvas-${summary.name}`,
      label: `Open canvas - ${summary.name}`,
      detail: "Switch canvas",
      icon: Layers,
      run: () => state$.canvasOpenRequest.set(summary.name),
    });
  }

  if (authoring) {
    actions.push({
      id: "edge-filter",
      label:
        edgeFilter === ""
          ? "Edge filter / show blocks"
          : edgeFilter === "blocks"
            ? "Edge filter / show relates"
            : "Edge filter / clear",
      detail: "Cycle edge filter: off, blocks, relates",
      icon: Layers,
      run: cycleEdgeFilter,
    });
    for (const flag of FLAG_CYCLE) {
      const active = activeFlag === flag;
      actions.push({
        id: `flag-${flag}`,
        label: `${active ? "Clear" : "Show"} ${flag} flags`,
        detail: `Flag filter / ${flag}`,
        icon: Flag,
        run: () => toggleFlagFilter(flag),
      });
    }
  }

  actions.push({
    id: "fit-view",
    label: "Fit view",
    detail: "Frame all nodes at readable scale",
    icon: Maximize,
    run: () => state$.fitViewRequest.set(state$.fitViewRequest.peek() + 1),
  });

  actions.push({
    id: "clear-selection",
    label: "Clear selection",
    detail: "Drop the selected node and edge",
    icon: CircleSlash,
    run: () => clearSelection(),
  });

  if (selectedNodeId) {
    actions.push({
      id: "copy-node-ref",
      label: "Copy node reference",
      detail: formatNodeRef({ canvasName, nodeId: selectedNodeId }),
      icon: Copy,
      run: () => void copySelectedNodeRef(),
    });
  }

  return actions;
};
