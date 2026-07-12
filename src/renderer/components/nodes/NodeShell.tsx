import type { ReactNode } from "react";
import { Handle, NodeToolbar, Position } from "@xyflow/react";
import { Ban, ExternalLink, Pencil, Trash2 } from "lucide-react";
import type { CanvasNode, EtherFlag } from "@shared/canvas";
import { borderColor, HUE, withAlpha } from "../../lib/theme";
import { deleteNode, toggleFlag } from "../../lib/mutations";
import { EntityBadges } from "../EntityBadges";

const HANDLE_SIDES = [["top", Position.Top], ["right", Position.Right], ["bottom", Position.Bottom], ["left", Position.Left]] as const;
const FLAG_HUES: Record<EtherFlag, string> = {
  blocker: HUE.crimson,
  attention: HUE.amber,
  parked: HUE.violet,
};

function ConnectionHandles() {
  return <>{HANDLE_SIDES.map(([name, pos]) => <Handle key={`s-${name}`} id={`s-${name}`} aria-label={`Connect from ${name}`} type="source" position={pos} className={`vellum-handle vellum-handle--source vellum-handle--${name}`} />)}{HANDLE_SIDES.map(([name, pos]) => <Handle key={`t-${name}`} id={`t-${name}`} aria-label={`Connect to ${name}`} type="target" position={pos} className={`vellum-handle vellum-handle--target vellum-handle--${name}`} />)}</>;
}

function NodeActions({ node, selected, onEdit }: { readonly node: CanvasNode; readonly selected: boolean; readonly onEdit?: () => void }) {
  const isBlocker = node.ether?.flags?.includes("blocker") ?? false;
  return <NodeToolbar isVisible={selected} position={Position.Top} offset={8}><div className="nodrag nopan flex items-center gap-1 rounded-md border border-white/10 bg-[#131110] px-1 py-1 shadow-lg shadow-black/40">
    {onEdit ? <button aria-label="Edit item" className="nodrag nopan grid size-7 place-items-center rounded text-[11px] text-slate-300 transition hover:bg-white/10 hover:text-[#EDE6DA]" title="edit item" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onEdit(); }}><Pencil size={14} /></button> : null}
    <button aria-label={isBlocker ? "Clear blocker flag" : "Flag blocker"} className="nodrag nopan grid size-7 place-items-center rounded text-[11px] transition hover:bg-white/10" style={{ color: isBlocker ? HUE.crimson : HUE.steel }} title={isBlocker ? "clear blocker" : "flag blocker"} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); toggleFlag(node.id, "blocker"); }}><Ban size={14} /></button>
    <button aria-label="Delete node" className="nodrag nopan grid size-7 place-items-center rounded text-[11px] text-slate-300 transition hover:bg-white/10 hover:text-[#E5484D]" title="delete node" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); deleteNode(node.id); }}><Trash2 size={14} /></button>
  </div></NodeToolbar>;
}

export function NodeShell({ node, selected, blocked, onEdit, onOpen, children }: { readonly node: CanvasNode; readonly selected: boolean; readonly blocked: boolean; readonly onEdit?: () => void; readonly onOpen?: () => void; readonly children: ReactNode }) {
  const flags = node.ether?.flags ?? [];
  const isBlocker = flags.includes("blocker");
  const primaryFlag: EtherFlag | undefined = isBlocker ? "blocker" : flags.includes("attention") ? "attention" : flags.includes("parked") ? "parked" : undefined;
  const primaryHue = primaryFlag ? FLAG_HUES[primaryFlag] : undefined;
  const border = isBlocker ? HUE.crimson : primaryHue ? withAlpha(primaryHue, 0.52) : borderColor(node.color, selected);
  const background = blocked
    ? `linear-gradient(135deg, ${withAlpha(HUE.crimson, 0.12)}, rgba(18,15,13,0.92))`
    : primaryFlag === "attention"
      ? `linear-gradient(135deg, ${withAlpha(HUE.amber, 0.09)}, rgba(14,13,12,0.96))`
      : primaryFlag === "parked"
        ? `linear-gradient(135deg, ${withAlpha(HUE.violet, 0.09)}, rgba(14,13,12,0.96))`
        : "linear-gradient(135deg, rgba(30,25,20,0.94), rgba(14,13,12,0.96))";
  const shadow = selected
    ? `0 0 0 1px ${withAlpha(HUE.amber, 0.25)}, 0 12px 30px rgba(0,0,0,0.22)`
    : primaryFlag === "attention"
      ? `0 0 0 1px ${withAlpha(HUE.amber, 0.14)}, 0 10px 28px rgba(0,0,0,0.18)`
      : primaryFlag === "parked"
        ? `0 0 0 1px ${withAlpha(HUE.violet, 0.14)}, 0 10px 28px rgba(0,0,0,0.18)`
        : "0 10px 28px rgba(0,0,0,0.18)";
  return <div className={`vellum-node group relative flex h-full w-full flex-col overflow-visible rounded-[10px] px-3.5 py-3 ${isBlocker ? "vellum-blocker" : ""}`} style={{ border: `1px solid ${selected ? withAlpha(HUE.amber, 0.7) : border}`, background, boxShadow: shadow, backdropFilter: "blur(10px)" }}>
    <div className="vellum-drag-handle" aria-label="Move node" title="drag to move node" />
    {onEdit ? <button className="vellum-node__edit nodrag nopan absolute right-2 top-2 z-10 grid size-6 place-items-center rounded text-slate-400 transition hover:bg-white/10 hover:text-[#EDE6DA]" aria-label="Edit item" title="edit item" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onEdit(); }}><Pencil size={12} /></button> : null}
    {onOpen ? <button className="vellum-node__open nodrag nopan absolute right-10 top-2 z-10 grid size-6 place-items-center rounded text-cyan-300/70 transition hover:bg-white/10 hover:text-cyan-200" aria-label="Open external link" title="open external link" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onOpen(); }}><ExternalLink size={12} /></button> : null}
    <ConnectionHandles /><NodeActions node={node} selected={selected} onEdit={onEdit} />
    {flags.length > 0 ? <div className="vellum-node__flag-rail">{flags.map((flag) => <span key={flag} className="vellum-node__flag" style={{ color: FLAG_HUES[flag], borderColor: withAlpha(FLAG_HUES[flag], 0.36), background: withAlpha(FLAG_HUES[flag], 0.09) }}>{flag}</span>)}</div> : null}
    <div className="vellum-node__body min-h-0 flex-1 overflow-hidden">
      {node.ether?.entity ? <EntityBadges entity={node.ether.entity} bindings={node.ether.bindings} /> : null}
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  </div>;
}
