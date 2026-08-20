import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { NodeResizer, NodeToolbar, Position, useReactFlow, useStoreApi } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { AlertTriangle, Crosshair, FolderOpen, Lock, ScrollText, Trash2 } from "lucide-react";
import type { FlowNode } from "../../lib/convert";
import { MAX_REGION_DEPTH } from "@shared/graph";
import { deleteNode, renameGroup } from "../../lib/mutations";
import { dragHoldMemberIds, resizeNode, syncPositions } from "../../lib/geometry";
import { state$, toggleConnectionFocus } from "../../lib/state";
import { accentColor, borderColor, HUE, INK, withAlpha } from "../../lib/theme";
import { markViewportBusy, releaseViewportBusy } from "../../lib/viewport-busy";
import {
  isMultiSelectGesture,
  stopNodeGestureUnlessMultiSelect,
  useShiftMultiSelectDominance,
} from "../../lib/multi-select-gesture";
import { RegionPathsModal } from "../RegionPathsModal";
import { IconButton, ToolbarPill } from "../ui";

function RegionToolbar({
  nodeId,
  selected,
  onPaths,
  hasPaths,
  connectionFocused,
  onToggleFocus,
}: {
  readonly nodeId: string;
  readonly selected: boolean;
  readonly onPaths: () => void;
  readonly hasPaths: boolean;
  readonly connectionFocused: boolean;
  readonly onToggleFocus: () => void;
}) {
  // pointerdown stopPropagation keeps RF from starting a drag; action on click
  // so Enter/Space on focused IconButton still fires (pointerdown-only is keyboard-dead).
  // Shift multi-select always wins — do not eat the gesture / run the action.
  const stopDrag = (event: React.PointerEvent | React.MouseEvent): boolean =>
    stopNodeGestureUnlessMultiSelect(event);
  // Multi-select: RTS bar owns bulk — suppress floating region pills.
  const multiSelect = use$(() => state$.selectedNodeIds.get().length > 1);
  if (!selected || multiSelect) return null;
  return <NodeToolbar isVisible position={Position.Top} offset={8}>
    <ToolbarPill>
      <IconButton
        className="nodrag nopan"
        aria-label={hasPaths ? "Region folder paths (set)" : "Region folder paths"}
        title={hasPaths ? "Folder paths set" : "Folder paths"}
        onPointerDown={stopDrag}
        onClick={(event) => { if (stopDrag(event)) return; onPaths(); }}
      >
        <FolderOpen size={14} />
      </IconButton>
      <IconButton
        className="nodrag nopan"
        aria-label={connectionFocused ? "Clear node focus" : "Focus node"}
        aria-pressed={connectionFocused}
        title={connectionFocused ? "Clear connection focus" : "Show this region's connections"}
        data-testid="node-toolbar-focus"
        data-focused={connectionFocused ? "true" : "false"}
        style={connectionFocused ? { color: HUE.cyan } : undefined}
        onPointerDown={stopDrag}
        onClick={(event) => { if (stopDrag(event)) return; onToggleFocus(); }}
      >
        <Crosshair size={14} />
      </IconButton>
      <IconButton
        className="nodrag nopan"
        aria-label="Delete region"
        tone="danger"
        title="Delete region"
        onPointerDown={stopDrag}
        onClick={(event) => { if (stopDrag(event)) return; deleteNode(nodeId); }}
      >
        <Trash2 size={14} />
      </IconButton>
    </ToolbarPill>
  </NodeToolbar>;
}

function RegionLabel({
  label,
  editing,
  draft,
  inputRef,
  onDraft,
  onCommit,
  onCancel,
  onEdit,
  accent,
}: {
  readonly label: string;
  readonly editing: boolean;
  readonly draft: string;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly onDraft: (value: string) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
  readonly onEdit: () => void;
  /** Optional plate accent — tints the label when the region has a color. */
  readonly accent?: string;
}) {
  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        data-focus-owner="canvas-draft"
        aria-label="Edit region label"
        className="nodrag rounded-sm bg-inset px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] outline-none"
        style={{ color: INK, border: `1px solid ${withAlpha(HUE.amber, 0.4)}` }}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") onCommit();
          if (event.key === "Escape") onCancel();
        }}
      />
    );
  }
  return (
    <span
      className="vellum-group__label cursor-text rounded-sm px-2 py-1 text-[10px] uppercase tracking-[0.18em]"
      style={accent ? { color: accent } : undefined}
      onDoubleClick={(event) => {
        if (event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        onEdit();
      }}
    >
      {label || "unnamed region"}
    </span>
  );
}

export function GroupNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  // Type is guaranteed "group" by React Flow nodeTypes routing — never early-
  // return before hooks. Narrow label/background only where fields differ.
  const label = node.type === "group" ? (node.label ?? "") : "";
  const stroke = borderColor(node.color, selected);
  const tint = accentColor(node.color);
  const [editing, setEditing] = useState(false);
  const [pathsOpen, setPathsOpen] = useState(false);
  const isEditTarget = use$(() => state$.editNodeId.get() === node.id);
  const isPathsTarget = use$(() => state$.regionPathsNodeId.get() === node.id);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);
  const instruction = node.ether?.region?.instruction;
  const pathMap = node.type === "group" ? node.ether?.region?.defaults?.paths : undefined;
  const hasPaths = Boolean(
    pathMap && Object.values(pathMap).some((p) => typeof p === "string" && p.trim().length > 0),
  );
  const connectionFocused = use$(() => state$.connectionFocusNodeId.get() === node.id);
  // Authoring-time-only warning (never a data rejection). Depth arrives with
  // the projection (convert.ts), so a resize (NodeResizer.onResizeEnd ->
  // resizeNode) repaints it without this card watching the whole document.
  const nestingDepth = data.regionDepth ?? 0;
  const nestedTooDeep = nestingDepth > MAX_REGION_DEPTH;

  useEffect(() => {
    if (!editing) return;
    setDraft(label);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing, label]);

  useEffect(() => {
    if (!isEditTarget) return;
    setEditing(true);
    state$.editNodeId.set("");
  }, [isEditTarget, node.id]);

  // Create-time (and any openRegionPaths trigger): open host folder paths modal.
  useEffect(() => {
    if (!isPathsTarget) return;
    setPathsOpen(true);
    state$.regionPathsNodeId.set("");
  }, [isPathsTarget, node.id]);

  const commit = () => {
    setEditing(false);
    if (draft !== label) renameGroup(node.id, draft);
  };

  // Selection chrome stays amber; unselected border + tint follow JSON Canvas
  // `color`. Region plate images are retired — color wash only.
  //
  // The whole wrapper is pointer-transparent (see convert.ts) so rubber-band
  // can start in the empty interior and reach the pane. The label strip is the
  // only movable chrome: it implements its own drag (React Flow never sees
  // wrapper events for this node) and click-select, and keeps the
  // shift-multi-select capture handlers for additive toggling.
  const multiSelectCapture = useShiftMultiSelectDominance(node.id);
  const rf = useReactFlow();
  const rfStore = useStoreApi();
  const regionDragRef = useRef<{
    readonly startFlow: { readonly x: number; readonly y: number };
    readonly startPos: { readonly x: number; readonly y: number };
    readonly members: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  } | null>(null);

  const beginRegionDrag = (event: React.PointerEvent): void => {
    if (event.button !== 0 || isMultiSelectGesture(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const flowNode = rf.getNode(node.id);
    if (flowNode === undefined) return;
    markViewportBusy();
    const startFlow = rf.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    const startPos = { ...flowNode.position };
    const members = new Map<string, { readonly x: number; readonly y: number }>();
    if (node.ether?.region?.hold) {
      const doc = state$.doc.peek();
      const regionDoc = doc.nodes.find((candidate) => candidate.id === node.id);
      if (regionDoc === undefined || regionDoc.type !== "group") return;
      for (const memberId of dragHoldMemberIds(doc, regionDoc)) {
        const member = rf.getNode(memberId);
        if (member !== undefined) members.set(memberId, { ...member.position });
      }
    }
    regionDragRef.current = { startFlow, startPos, members };
    const onMove = (event: PointerEvent): void => {
      const drag = regionDragRef.current;
      if (drag === null) return;
      const now = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const dx = now.x - drag.startFlow.x;
      const dy = now.y - drag.startFlow.y;
      rf.updateNode(node.id, {
        position: { x: drag.startPos.x + dx, y: drag.startPos.y + dy },
      });
      for (const [memberId, position] of drag.members) {
        rf.updateNode(memberId, {
          position: { x: position.x + dx, y: position.y + dy },
        });
      }
    };
    const onUp = (): void => {
      regionDragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      releaseViewportBusy();
      // Persist positions into the document, mirroring RF's onNodeDragStop.
      const positions = new Map<string, { readonly x: number; readonly y: number }>();
      for (const flow of rf.getNodes()) {
        positions.set(flow.id, flow.position);
      }
      syncPositions(positions);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const selectRegionOnClick = (event: React.MouseEvent): void => {
    if (isMultiSelectGesture(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const state = rfStore.getState();
    if (state.nodeLookup.get(node.id)?.selected !== true) {
      state.addSelectedNodes([node.id]);
    }
  };
  const plateBorder = selected ? withAlpha(HUE.amber, 0.6) : stroke;
  return <div
    className="vellum-group relative h-full w-full rounded-[14px]"
    style={{
      border: `1px solid ${plateBorder}`,
      pointerEvents: "none",
      background: node.color
        ? `linear-gradient(135deg, ${withAlpha(tint, 0.08)}, color-mix(in oklab, var(--color-ground) 25%, transparent))`
        : "linear-gradient(135deg, color-mix(in oklab, var(--color-raise) 22%, transparent), color-mix(in oklab, var(--color-ground) 12%, transparent))",
      boxShadow: selected ? `0 0 0 1px ${withAlpha(HUE.amber, 0.18)}` : "none",
    }}
  >
    <div style={{ pointerEvents: "auto" }}>
      <NodeResizer isVisible={selected} minWidth={320} minHeight={180} color={HUE.amber} handleClassName="vellum-resize-handle" lineClassName="vellum-resize-line" onResizeEnd={(_event, params) => resizeNode(node.id, params)} />
    </div>
    <div style={{ pointerEvents: "auto" }}>
      <RegionToolbar
        nodeId={node.id}
        selected={selected}
        onPaths={() => setPathsOpen(true)}
        hasPaths={hasPaths}
        connectionFocused={connectionFocused}
        onToggleFocus={() => toggleConnectionFocus(node.id)}
      />
    </div>
    <div
      className="region-drag-handle absolute left-2 top-2 flex cursor-grab items-center gap-1 active:cursor-grabbing"
      style={{ pointerEvents: "auto" }}
      title="Drag region"
      onPointerDown={beginRegionDrag}
      onClick={selectRegionOnClick}
      onPointerDownCapture={multiSelectCapture.onPointerDownCapture}
      onClickCapture={multiSelectCapture.onClickCapture}
    >
      <RegionLabel label={label} editing={editing} draft={draft} inputRef={inputRef} onDraft={setDraft} onCommit={commit} onCancel={() => setEditing(false)} onEdit={() => setEditing(true)} accent={node.color ? tint : undefined} />
      {node.ether?.region?.hold ? <Lock aria-label="Region holds its contents" size={10} style={{ opacity: 0.5, color: INK, flexShrink: 0 }} /> : null}
      {hasPaths ? <span title="Region has host folder paths" style={{ display: "inline-flex", flexShrink: 0 }}><FolderOpen aria-label="Region has folder paths" size={10} style={{ opacity: 0.5, color: INK }} /></span> : null}
      {instruction ? <span title={instruction} style={{ display: "inline-flex", flexShrink: 0 }}><ScrollText aria-label="Region has a briefing" size={10} style={{ opacity: 0.5, color: INK }} /></span> : null}
      {nestedTooDeep ? (
        <span
          title={`Nested ${nestingDepth} regions deep, past ${MAX_REGION_DEPTH} — still works, but consider flattening`}
          style={{ display: "inline-flex", flexShrink: 0 }}
        >
          <AlertTriangle aria-label="Region nesting is very deep" size={10} style={{ opacity: 0.8, color: HUE.amber }} />
        </span>
      ) : null}
    </div>
    {pathsOpen ? <div style={{ pointerEvents: "auto" }}><RegionPathsModal nodeId={node.id} onClose={() => setPathsOpen(false)} /></div> : null}
  </div>;
}
