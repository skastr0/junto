import type { ReactNode } from "react";
import { Handle, NodeToolbar, Position } from "@xyflow/react";
import { Ban, Trash2 } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { borderColor, CARD_FILL, HUE, withAlpha } from "../../lib/theme";
import { deleteNode, toggleFlag } from "../../lib/mutations";
import { EntityBadges } from "../EntityBadges";

const HANDLE_SIDES = [
  ["top", Position.Top],
  ["right", Position.Right],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
] as const;

export function NodeShell({
  node,
  selected,
  blocked,
  children,
}: {
  readonly node: CanvasNode;
  readonly selected: boolean;
  readonly blocked: boolean;
  readonly children: ReactNode;
}) {
  const isBlocker = node.ether?.flags?.includes("blocker") ?? false;
  const border = isBlocker ? HUE.crimson : borderColor(node.color, selected);

  return (
    <div
      className={`vellum-node group relative flex h-full w-full flex-col overflow-hidden rounded-lg px-3 py-2.5 ${
        isBlocker ? "vellum-blocker" : ""
      }`}
      style={{
        border: `1px solid ${selected ? withAlpha(HUE.amber, 0.7) : border}`,
        background: blocked ? withAlpha(HUE.crimson, 0.06) : CARD_FILL,
        boxShadow: selected ? `0 0 0 1px ${withAlpha(HUE.amber, 0.25)}` : "none",
      }}
    >
      {HANDLE_SIDES.map(([name, pos]) => (
        <Handle key={`s-${name}`} id={`s-${name}`} type="source" position={pos} className="vellum-handle" />
      ))}
      {HANDLE_SIDES.map(([name, pos]) => (
        <Handle key={`t-${name}`} id={`t-${name}`} type="target" position={pos} className="vellum-handle" />
      ))}

      <NodeToolbar isVisible={selected} position={Position.Top} offset={8}>
        <div className="flex items-center gap-1 rounded-md border border-white/10 bg-[#131110] px-1 py-1 shadow-lg shadow-black/40">
          <button
            className="grid size-7 place-items-center rounded text-[11px] transition hover:bg-white/10"
            style={{ color: isBlocker ? HUE.crimson : HUE.steel }}
            title={isBlocker ? "clear blocker" : "flag blocker"}
            onClick={() => toggleFlag(node.id, "blocker")}
          >
            <Ban size={14} />
          </button>
          <button
            className="grid size-7 place-items-center rounded text-slate-300 transition hover:bg-white/10 hover:text-[#E5484D]"
            title="delete node"
            onClick={() => deleteNode(node.id)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </NodeToolbar>

      {node.ether?.entity ? (
        <EntityBadges entity={node.ether.entity} bindings={node.ether.bindings} />
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
