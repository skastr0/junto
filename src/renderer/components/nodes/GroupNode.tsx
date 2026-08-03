import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { NodeResizer, NodeToolbar, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Crosshair, FolderOpen, Lock, Pencil, ScrollText, Trash2 } from "lucide-react";
import type { FlowNode } from "../../lib/convert";
import { deleteNode, renameGroup } from "../../lib/mutations";
import { resizeNode } from "../../lib/geometry";
import { state$, toggleConnectionFocus } from "../../lib/state";
import { accentColor, borderColor, HUE, INK, withAlpha } from "../../lib/theme";
import {
  stopNodeGestureUnlessMultiSelect,
  useShiftMultiSelectDominance,
} from "../../lib/multi-select-gesture";
import { RegionPathsModal } from "../RegionPathsModal";
import { IconButton, ToolbarPill } from "../ui";

function RegionToolbar({
  nodeId,
  selected,
  onEdit,
  onPaths,
  hasPaths,
  connectionFocused,
  onToggleFocus,
}: {
  readonly nodeId: string;
  readonly selected: boolean;
  readonly onEdit: () => void;
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
  return <NodeToolbar isVisible={selected && !multiSelect} position={Position.Top} offset={8}>
    <ToolbarPill>
      <IconButton
        className="nodrag nopan"
        aria-label="Edit region"
        title="edit region"
        onPointerDown={stopDrag}
        onClick={(event) => { if (stopDrag(event)) return; onEdit(); }}
      >
        <Pencil size={14} />
      </IconButton>
      <IconButton
        className="nodrag nopan"
        aria-label={hasPaths ? "Region folder paths (set)" : "Region folder paths"}
        title={hasPaths ? "folder paths (set)" : "folder paths"}
        onPointerDown={stopDrag}
        onClick={(event) => { if (stopDrag(event)) return; onPaths(); }}
      >
        <FolderOpen size={14} />
      </IconButton>
      <IconButton
        className="nodrag nopan"
        aria-label={connectionFocused ? "Clear node focus" : "Focus node"}
        aria-pressed={connectionFocused}
        title={connectionFocused ? "clear connection focus" : "focus node connections"}
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
        title="delete region"
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
  // pointer-events: plate none + chrome auto so rubber-band can start in empty
  // interior without dragging the region (dragHandle lives on the label strip).
  const multiSelectCapture = useShiftMultiSelectDominance(node.id);
  const plateBorder = selected ? withAlpha(HUE.amber, 0.6) : stroke;
  return <div
    className="vellum-group relative h-full w-full rounded-[14px]"
    style={{
      border: `1px solid ${plateBorder}`,
      pointerEvents: "none",
      background: node.color
        ? `linear-gradient(135deg, ${withAlpha(tint, 0.08)}, rgba(13,12,11,0.25))`
        : "linear-gradient(135deg, rgba(33,27,21,0.22), rgba(11,11,10,0.12))",
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
        onEdit={() => setEditing(true)}
        onPaths={() => setPathsOpen(true)}
        hasPaths={hasPaths}
        connectionFocused={connectionFocused}
        onToggleFocus={() => toggleConnectionFocus(node.id)}
      />
    </div>
    <div
      className="region-drag-handle absolute left-2 top-2 flex cursor-grab items-center gap-1 active:cursor-grabbing"
      style={{ pointerEvents: "auto" }}
      title="drag region"
      onPointerDownCapture={multiSelectCapture.onPointerDownCapture}
      onClickCapture={multiSelectCapture.onClickCapture}
    >
      <RegionLabel label={label} editing={editing} draft={draft} inputRef={inputRef} onDraft={setDraft} onCommit={commit} onCancel={() => setEditing(false)} onEdit={() => setEditing(true)} accent={node.color ? tint : undefined} />
      {node.ether?.region?.hold ? <Lock aria-label="Region holds its contents" size={10} style={{ opacity: 0.5, color: INK, flexShrink: 0 }} /> : null}
      {hasPaths ? <span title="Region has host folder paths" style={{ display: "inline-flex", flexShrink: 0 }}><FolderOpen aria-label="Region has folder paths" size={10} style={{ opacity: 0.5, color: INK }} /></span> : null}
      {instruction ? <span title={instruction} style={{ display: "inline-flex", flexShrink: 0 }}><ScrollText aria-label="Region has a briefing" size={10} style={{ opacity: 0.5, color: INK }} /></span> : null}
    </div>
    {pathsOpen ? <div style={{ pointerEvents: "auto" }}><RegionPathsModal nodeId={node.id} onClose={() => setPathsOpen(false)} /></div> : null}
  </div>;
}
