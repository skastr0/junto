import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { NodeResizer, NodeToolbar, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Lock, Pencil, ScrollText, Trash2 } from "lucide-react";
import type { FlowNode } from "../../lib/convert";
import { deleteNode, renameGroup } from "../../lib/mutations";
import { resizeNode } from "../../lib/geometry";
import { state$ } from "../../lib/state";
import { kernel$ } from "../../lib/kernel-view";
import { accentColor, borderColor, HUE, INK, withAlpha } from "../../lib/theme";
import { IconButton, ToolbarPill } from "../ui";

function RegionToolbar({ nodeId, selected, onEdit }: { readonly nodeId: string; readonly selected: boolean; readonly onEdit: () => void }) {
  return <NodeToolbar isVisible={selected} position={Position.Top} offset={8}>
    <ToolbarPill>
      <IconButton className="nodrag nopan" aria-label="Edit region" title="edit region" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onEdit(); }}><Pencil size={14} /></IconButton>
      <IconButton className="nodrag nopan" aria-label="Delete region" tone="danger" title="delete region" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); deleteNode(nodeId); }}><Trash2 size={14} /></IconButton>
    </ToolbarPill>
  </NodeToolbar>;
}

function RegionLabel({ label, editing, draft, inputRef, onDraft, onCommit, onCancel, onEdit }: { readonly label: string; readonly editing: boolean; readonly draft: string; readonly inputRef: React.RefObject<HTMLInputElement | null>; readonly onDraft: (value: string) => void; readonly onCommit: () => void; readonly onCancel: () => void; readonly onEdit: () => void }) {
  if (editing) return <input ref={inputRef} autoFocus aria-label="Edit region label" className="nodrag rounded-sm bg-inset px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] outline-none" style={{ color: INK, border: `1px solid ${withAlpha(HUE.amber, 0.4)}` }} value={draft} onChange={(event) => onDraft(event.target.value)} onBlur={onCommit} onKeyDown={(event) => { if (event.key === "Enter") onCommit(); if (event.key === "Escape") onCancel(); }} />;
  return <span className="vellum-group__label cursor-text rounded-sm px-2 py-1 text-[10px] uppercase tracking-[0.18em]" onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onEdit(); }}>{label || "unnamed region"}</span>;
}

export function GroupNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  // Type is guaranteed "group" by React Flow nodeTypes routing — never early-
  // return before hooks. Narrow label/background only where fields differ.
  const label = node.type === "group" ? (node.label ?? "") : "";
  const stroke = borderColor(node.color, selected);
  const tint = accentColor(node.color);
  const background = node.type === "group" ? node.background : undefined;
  const hasBackground = Boolean(background);
  const backgroundStyle = node.type === "group" ? (node.backgroundStyle ?? "cover") : "cover";
  const [editing, setEditing] = useState(false);
  const isEditTarget = use$(() => state$.editNodeId.get() === node.id);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);
  const armed = Boolean(use$(kernel$.armed[node.id]));
  const instruction = node.ether?.region?.instruction;

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

  const commit = () => {
    setEditing(false);
    if (draft !== label) renameGroup(node.id, draft);
  };

  return <div className="vellum-group relative h-full w-full rounded-[14px]" style={{ border: `1px solid ${selected ? withAlpha(HUE.amber, 0.6) : stroke}`, backgroundImage: hasBackground ? `linear-gradient(135deg, ${withAlpha(tint, 0.1)}, rgba(13,12,11,0.5)), url(${JSON.stringify(background)})` : undefined, background: hasBackground ? undefined : node.color ? `linear-gradient(135deg, ${withAlpha(tint, 0.08)}, rgba(13,12,11,0.25))` : "linear-gradient(135deg, rgba(33,27,21,0.22), rgba(11,11,10,0.12))", backgroundSize: hasBackground ? (backgroundStyle === "cover" ? "cover" : backgroundStyle === "ratio" ? "contain" : "auto") : undefined, backgroundRepeat: hasBackground && backgroundStyle === "repeat" ? "repeat" : "no-repeat", backgroundPosition: hasBackground ? "center" : undefined, boxShadow: selected ? `0 0 0 1px ${withAlpha(HUE.amber, 0.18)}` : "none" }}>
    <NodeResizer isVisible={selected} minWidth={320} minHeight={180} color={HUE.amber} handleClassName="vellum-resize-handle" lineClassName="vellum-resize-line" onResizeEnd={(_event, params) => resizeNode(node.id, params)} />
    <RegionToolbar nodeId={node.id} selected={selected} onEdit={() => setEditing(true)} />
    <div className="absolute left-2 top-2 flex items-center gap-1">
      <RegionLabel label={label} editing={editing} draft={draft} inputRef={inputRef} onDraft={setDraft} onCommit={commit} onCancel={() => setEditing(false)} onEdit={() => setEditing(true)} />
      {node.ether?.region?.hold ? <Lock aria-label="Region holds its contents" size={10} style={{ opacity: 0.5, color: INK, flexShrink: 0 }} /> : null}
      {instruction ? <span title={instruction} style={{ display: "inline-flex", flexShrink: 0 }}><ScrollText aria-label="Region has a pulse briefing" size={10} style={{ opacity: 0.5, color: INK }} /></span> : null}
      {armed ? <span className="vellum-armed-dot" title="armed — pulses spend real agent turns" style={{ background: HUE.amber }} /> : null}
    </div>
  </div>;
}
