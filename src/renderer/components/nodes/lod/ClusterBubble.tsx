import { motion } from "motion/react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { ClusterBubbleData } from "../../../lib/lod/flow-types";
import { HUE, INK, withAlpha } from "../../../lib/theme";

const hiddenHandleStyle = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: "none", background: "transparent", pointerEvents: "none" as const };

const LOD_MOTION = {
  initial: { opacity: 0, scale: 0.9 },
  animate: { opacity: 1, scale: 1 },
  transition: { duration: 0.22, ease: [0.22, 0.61, 0.36, 1] as const },
};

// A map-style cluster of regions + loose nodes at the far tier. The count is
// the dominant read (how much is here); up to three labels name what it holds,
// shown only when the bubble is large enough to carry them. Amber ring on the
// deep-field ground — a constellation node, not a badge.
export function ClusterBubble({ data, selected }: NodeProps<Node<ClusterBubbleData, "cluster-bubble">>) {
  const bubble = data.bubble;
  // The bubble is square (style width === height); read one to scale type.
  const countSize = Math.round(Math.min(46, Math.max(20, bubble.count >= 100 ? 26 : 34)));
  const showLabels = bubble.labels.length > 0 && bubble.weight >= 4;
  return (
    <motion.div
      {...LOD_MOTION}
      className="vellum-lod-bubble flex h-full w-full cursor-pointer flex-col items-center justify-center rounded-full text-center"
      style={{
        border: `1px solid ${withAlpha(HUE.amber, selected ? 0.7 : 0.4)}`,
        background: `radial-gradient(circle at 50% 38%, ${withAlpha(HUE.amber, 0.14)}, rgba(13,12,11,0.66) 72%)`,
        boxShadow: selected
          ? `0 0 0 1px ${withAlpha(HUE.amber, 0.28)}, 0 16px 40px rgba(0,0,0,0.4)`
          : `0 14px 36px rgba(0,0,0,0.34), inset 0 0 22px ${withAlpha(HUE.amber, 0.05)}`,
      }}
    >
      <Handle type="target" position={Position.Left} style={hiddenHandleStyle} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={hiddenHandleStyle} isConnectable={false} />
      <span className="font-semibold leading-none tabular-nums" style={{ color: INK, fontSize: countSize, fontFamily: '"Arial Narrow", "Avenir Next Condensed", ui-monospace, monospace' }}>
        {bubble.count}
      </span>
      <span className="mt-1 text-[8px] uppercase tracking-[0.18em]" style={{ color: withAlpha(HUE.amber, 0.7) }}>
        {bubble.regionCount > 0 ? `${bubble.regionCount} region${bubble.regionCount === 1 ? "" : "s"}` : "nodes"}
      </span>
      {showLabels ? (
        <div className="mt-1.5 flex max-w-[86%] flex-col gap-0.5">
          {bubble.labels.map((label) => (
            <span key={label} className="truncate text-[9px] uppercase leading-tight tracking-[0.12em]" style={{ color: withAlpha(INK, 0.5) }} title={label}>
              {label}
            </span>
          ))}
        </div>
      ) : null}
    </motion.div>
  );
}
