import { useEffect, useRef, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import type { FlowNode } from "../../lib/convert";
import { renameGroup } from "../../lib/mutations";
import { borderColor, HUE, INK, withAlpha } from "../../lib/theme";

// Region plate: a large translucent rect behind everything, 1px stroke, with a
// label chip pinned top-left. Double-click the chip to rename.
export function GroupNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const label = node.type === "group" ? (node.label ?? "") : "";
  const stroke = borderColor(node.color, selected);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(label);
      ref.current?.focus();
      ref.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== label) renameGroup(node.id, draft);
  };

  return (
    <div
      className="relative h-full w-full rounded-xl"
      style={{
        border: `1px solid ${selected ? withAlpha(HUE.amber, 0.6) : stroke}`,
        background: node.color?.startsWith("#")
          ? withAlpha(node.color, 0.05)
          : "rgba(255,255,255,0.014)",
      }}
    >
      <div className="absolute left-2 top-2">
        {editing ? (
          <input
            ref={ref}
            className="nodrag rounded-sm bg-[#131110] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] outline-none"
            style={{ color: INK, border: `1px solid ${withAlpha(HUE.amber, 0.4)}` }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span
            className="cursor-text rounded-sm px-2 py-0.5 text-[10px] uppercase tracking-[0.16em]"
            style={{
              color: withAlpha(INK, 0.72),
              background: "rgba(12,11,10,0.72)",
              border: `1px solid ${withAlpha(INK, 0.1)}`,
            }}
            onDoubleClick={() => setEditing(true)}
          >
            {label || "region"}
          </span>
        )}
      </div>
    </div>
  );
}
