import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { NodeResizer, NodeToolbar, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Lock, Pencil, Trash2 } from "lucide-react";
import type { FlowNode } from "../../lib/convert";
import { deleteNode, renameGroup } from "../../lib/mutations";
import { resizeNode } from "../../lib/geometry";
import { state$ } from "../../lib/state";
import { accentColor, borderColor, HUE, INK, withAlpha } from "../../lib/theme";

function RegionToolbar({ nodeId, selected, onEdit }: { readonly nodeId: string; readonly selected: boolean; readonly onEdit: () => void }) {
  return <NodeToolbar isVisible={selected} position={Position.Top} offset={8}>
    <div className="nodrag nopan flex items-center gap-1 rounded-md border border-white/10 bg-[#131110] px-1 py-1 shadow-lg shadow-black/40">
      <button aria-label="Edit region" className="nodrag nopan grid size-7 place-items-center rounded text-slate-300 transition hover:bg-white/10" title="edit region" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onEdit(); }}><Pencil size={14} /></button>
      <button aria-label="Delete region" className="nodrag nopan grid size-7 place-items-center rounded text-slate-300 transition hover:bg-white/10 hover:text-[#E5484D]" title="delete region" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); deleteNode(nodeId); }}><Trash2 size={14} /></button>
    </div>
  </NodeToolbar>;
}

function RegionLabel({ label, editing, draft, inputRef, onDraft, onCommit, onCancel, onEdit }: { readonly label: string; readonly editing: boolean; readonly draft: string; readonly inputRef: React.RefObject<HTMLInputElement | null>; readonly onDraft: (value: string) => void; readonly onCommit: () => void; readonly onCancel: () => void; readonly onEdit: () => void }) {
  if (editing) return <input ref={inputRef} autoFocus aria-label="Edit region label" className="nodrag rounded-sm bg-[#131110] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] outline-none" style={{ color: INK, border: `1px solid ${withAlpha(HUE.amber, 0.4)}` }} value={draft} onChange={(event) => onDraft(event.target.value)} onBlur={onCommit} onKeyDown={(event) => { if (event.key === "Enter") onCommit(); if (event.key === "Escape") onCancel(); }} />;
  return <span className="vellum-group__label cursor-text rounded-sm px-2 py-1 text-[10px] uppercase tracking-[0.18em]" onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); onEdit(); }}>{label || "unnamed region"}</span>;
}

export function GroupNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  if (node.type !== "group") return null;
  const label = node.label ?? "";
  const stroke = borderColor(node.color, selected);
  const tint = accentColor(node.color);
  const hasBackground = Boolean(node.background);
  const backgroundStyle = node.backgroundStyle ?? "cover";
  const [editing, setEditing] = useState(false);
  const editNodeId = use$(state$.editNodeId);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(label);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing, label]);

  useEffect(() => {
    if (editNodeId !== node.id) return;
    setEditing(true);
    state$.editNodeId.set("");
  }, [editNodeId, node.id]);

  const commit = () => {
    setEditing(false);
    if (draft !== label) renameGroup(node.id, draft);
  };

  return <div className="vellum-group relative h-full w-full rounded-[14px]" style={{ border: `1px solid ${selected ? withAlpha(HUE.amber, 0.6) : stroke}`, backgroundImage: hasBackground ? `linear-gradient(135deg, ${withAlpha(tint, 0.1)}, rgba(13,12,11,0.5)), url(${JSON.stringify(node.background)})` : undefined, background: hasBackground ? undefined : node.color ? `linear-gradient(135deg, ${withAlpha(tint, 0.08)}, rgba(13,12,11,0.25))` : "linear-gradient(135deg, rgba(33,27,21,0.22), rgba(11,11,10,0.12))", backgroundSize: hasBackground ? (backgroundStyle === "cover" ? "cover" : backgroundStyle === "ratio" ? "contain" : "auto") : undefined, backgroundRepeat: hasBackground && backgroundStyle === "repeat" ? "repeat" : "no-repeat", backgroundPosition: hasBackground ? "center" : undefined, boxShadow: selected ? `0 0 0 1px ${withAlpha(HUE.amber, 0.18)}` : "none" }}>
    <NodeResizer isVisible={selected} minWidth={320} minHeight={180} color={HUE.amber} handleClassName="vellum-resize-handle" lineClassName="vellum-resize-line" onResizeEnd={(_event, params) => resizeNode(node.id, params)} />
    <RegionToolbar nodeId={node.id} selected={selected} onEdit={() => setEditing(true)} />
    <div className="absolute left-2 top-2 flex items-center gap-1">
      <RegionLabel label={label} editing={editing} draft={draft} inputRef={inputRef} onDraft={setDraft} onCommit={commit} onCancel={() => setEditing(false)} onEdit={() => setEditing(true)} />
      {node.ether?.region?.hold ? <Lock aria-label="Region holds its contents" size={10} style={{ opacity: 0.5, color: INK, flexShrink: 0 }} /> : null}
    </div>
  </div>;
}
