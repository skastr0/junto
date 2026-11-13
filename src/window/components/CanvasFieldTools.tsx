/**
 * The field tools beside the canvas: add an item, fit all.
 *
 * The camera and the pointer-to-board conversion come from the CanvasApi, so
 * the same tools sit beside the old canvas and the GPU canvas. Creation
 * chooses the same unobstructed canvas positions either way.
 */

import { useCallback, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { Expand, Plus, X } from "lucide-react";
import { AGENT_NODE_SIZE } from "../lib/node-geometry";
import { addNode } from "../lib/mutations";
import { topZ } from "../lib/model-edits";
import { findOpenPosition } from "../lib/geometry";
import { state$ } from "../lib/state";
import { modelStore } from "../lib/use-model";
import { useContentCalls, type ContentCalls } from "../lib/content-calls";
import { placeProfileInSlot } from "../lib/profiles-state";
import { openProfileDraft } from "../lib/profile-draft-state";
import { placeSquadInSlot } from "../lib/squads-state";
import { resolvePageSpawnDefaults } from "@shared/region-defaults";
import { ARTIFACTS_ENABLED, BROWSER_ENABLED, TASKS_ENABLED } from "@shared/features";
import {
  newArtifacts,
  newAutomations,
  newLabel,
  newNote,
  newPage,
  newRegion,
  newSeat,
  newTaskBoard,
} from "../lib/model-factories";
import { canvasApi } from "../canvas/shell/canvas-api";
import { NodePaletteModeDeck, type ModeDeckActions } from "./node-palette/NodePaletteModeDeck";
import { FocusSurface } from "./FocusSurface";
import { IconButton, OverlayHeader } from "./ui";

export const onTop = (position: { readonly x: number; readonly y: number }) => ({
  ...position, z: topZ(modelStore.canvasOf(state$.canvasName.peek())),
});

/** Node creation against a caller-supplied placement strategy. */
export const makeAddActions = (
  positionFor: (size: { width: number; height: number }) => { x: number; y: number },
  dismiss: () => void,
  content: ContentCalls | undefined,
): ModeDeckActions => ({
  create: (kind) => {
    const size = kind === "text"
      ? { width: 240, height: 100 }
      : { width: 560, height: 320 };
    const position = positionFor(size);
    const node = kind === "text"
      ? newNote(onTop(position))
      : newRegion(onTop(position));
    addNode(node);
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addSquad: async (squadId, launch) => {
    const outcome = await placeSquadInSlot(squadId, positionFor, launch, content);
    if (outcome !== "needs-folder") dismiss();
    return outcome;
  },
  addProfile: async (profileId, launch) => {
    const outcome = await placeProfileInSlot(profileId, positionFor, launch, content);
    if (outcome !== "needs-folder") dismiss();
    return outcome;
  },
  createProfile: () => {
    dismiss();
    openProfileDraft();
  },
  addConfiguredAgent: (choices, position) => {
    const node = newSeat(onTop(position), choices);
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addTasks: () => {
    if (!TASKS_ENABLED) return;
    const position = positionFor({ width: 240, height: 120 });
    const node = newTaskBoard(onTop(position));
    addNode(node);
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addArtifacts: () => {
    if (!ARTIFACTS_ENABLED) return;
    const position = positionFor({ width: 240, height: 120 });
    const node = newArtifacts(onTop(position));
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addAutomations: () => {
    const position = positionFor({ width: 240, height: 120 });
    const node = newAutomations(onTop(position));
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    dismiss();
  },
  addGit: () => {
    const position = positionFor({ width: 280, height: 128 });
    window.dispatchEvent(new CustomEvent("junto:new-git", { detail: position }));
    dismiss();
  },
  addFiles: () => {
    const position = positionFor({ width: 280, height: 128 });
    window.dispatchEvent(new CustomEvent("junto:new-files", { detail: position }));
    dismiss();
  },
  addTerminal: () => {
    const position = positionFor({ width: 260, height: 110 });
    window.dispatchEvent(new CustomEvent("junto:new-terminal", { detail: position }));
    dismiss();
  },
  addPage: () => {
    if (!BROWSER_ENABLED) return;
    const size = { width: 260, height: 110 };
    const position = positionFor(size);
    const seed = resolvePageSpawnDefaults(
      modelStore.canvasOf(state$.canvasName.peek()),
      position.x + size.width / 2,
      position.y + size.height / 2,
    );
    const node = newPage(onTop(position), seed?.url?.trim() || "https://example.com", {
      ...(seed?.profile ? { profile: seed.profile } : {}),
    });
    addNode(node);
    dismiss();
  },
  addLabel: () => {
    const size = { width: 160, height: 40 };
    const position = positionFor(size);
    const node = newLabel(onTop(position));
    addNode(node);
    state$.focusNodeId.set(node.id);
    dismiss();
  },
});

export function ModeDeckFocus({
  actions,
  agentPosition,
  onClose,
}: {
  readonly actions: ModeDeckActions;
  readonly agentPosition: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}) {
  return (
    <FocusSurface
      measure="workspace"
      height="fit"
      label="Add canvas item"
      onClose={onClose}
      panelClassName="node-deck-focus-panel"
    >
      <OverlayHeader
        title="Add item"
        status="Choose an agent or work surface"
        actions={
          <IconButton aria-label="Close add canvas item" title="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />
      <NodePaletteModeDeck actions={actions} agentPosition={agentPosition} />
    </FocusSurface>
  );
}

export function CanvasFieldTools() {
  // Shared with the command bar action: the palette opens from either the
  // field trigger or "Add canvas item" in the palette.
  const open = use$(state$.nodePaletteOpen);
  const dismiss = useCallback(() => { state$.nodePaletteOpen.set(false); }, []);

  // A non-overlapping slot near the viewport center for a node of the given size.
  const nextPosition = (size: { width: number; height: number }) => {
    const canvasNodes = [...modelStore.canvasOf(state$.canvasName.peek()).nodes.values()];
    const slot = canvasNodes.length;
    const gridPlacement = slot < 6
      ? { x: (slot % 3) * 340 - 120, y: Math.floor(slot / 3) * 190 - 60 }
      : null;
    const center = gridPlacement
      ? { x: gridPlacement.x + size.width / 2, y: gridPlacement.y + size.height / 2 }
      : (canvasApi()?.screenToBoard({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
        ?? { x: 0, y: 0 });
    return gridPlacement ? gridPlacement : findOpenPosition(canvasNodes, center, size);
  };

  const content = useContentCalls();
  const actions = makeAddActions(nextPosition, dismiss, content);
  // This position is shared with the persistent launch context while the deck
  // is open, so its region default describes the same next-agent placement.
  const agentPosition = useMemo(
    () => nextPosition(AGENT_NODE_SIZE),
    // Recompute only when the deck opens; do not make folder/host interaction
    // shift the containing-region decision underneath the operator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  return (
    <div className="rts-field-tools" aria-label="Canvas field tools">
      <div className="node-deck-host node-deck-host--docked" data-canvas-menu-surface>
        <button
          type="button"
          className="node-deck-trigger"
          aria-label="Add canvas item"
          aria-expanded={open}
          onClick={() => { state$.nodePaletteOpen.set(!state$.nodePaletteOpen.peek()); }}
        >
          <Plus size={12} /><span>add item</span>
        </button>
        {open ? <ModeDeckFocus actions={actions} agentPosition={agentPosition} onClose={dismiss} /> : null}
      </div>
      <button
        type="button"
        className="rts-field-tools__fit"
        aria-label="Fit all nodes"
        title="Fit all nodes"
        onClick={() => canvasApi()?.fit()}
      >
        <Expand size={12} />fit all
      </button>
    </div>
  );
}
