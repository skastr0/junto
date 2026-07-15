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
//
// This is the tier's entire subject, so its idle (non-hover) presence has to
// carry on its own at the far tier's deepest zoom (~0.15, minZoom 0.08) —
// where React Flow's pane transform scales every CSS px down by that same
// factor. A 1px hairline and a soft label wash both survive that scale-down
// as near-nothing; a 2px ring plus a standing (not hover-only) ambient glow,
// and a bolder/tighter label treatment, are what let an "instrument dial at
// night" read as unmistakable rather than a smudge — never bright, well
// short of a map-pin.
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
        border: `2px solid ${withAlpha(HUE.amber, selected ? 0.88 : 0.64)}`,
        background: `radial-gradient(circle at 50% 38%, ${withAlpha(HUE.amber, 0.16)}, rgba(13,12,11,0.66) 72%)`,
        boxShadow: selected
          ? `0 0 0 1px ${withAlpha(HUE.amber, 0.34)}, 0 0 20px ${withAlpha(HUE.amber, 0.3)}, 0 16px 40px rgba(0,0,0,0.4)`
          : `0 0 14px ${withAlpha(HUE.amber, 0.22)}, 0 14px 36px rgba(0,0,0,0.34), inset 0 0 22px ${withAlpha(HUE.amber, 0.07)}`,
      }}
    >
      <Handle type="target" position={Position.Left} style={hiddenHandleStyle} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={hiddenHandleStyle} isConnectable={false} />
      <span className="font-bold leading-none tabular-nums" style={{ color: INK, fontSize: countSize, fontFamily: '"Arial Narrow", "Avenir Next Condensed", ui-monospace, monospace' }}>
        {bubble.count}
      </span>
      <span className="mt-1 text-[8px] uppercase tracking-[0.18em]" style={{ color: withAlpha(HUE.amber, 0.7) }}>
        {bubble.regionCount > 0 ? `${bubble.regionCount} region${bubble.regionCount === 1 ? "" : "s"}` : "nodes"}
      </span>
      {showLabels ? (
        <div className="mt-1.5 flex max-w-[86%] flex-col gap-0.5">
          {bubble.labels.map((label) => (
            <span key={label} className="truncate text-[12px] font-medium uppercase leading-tight tracking-[0.04em]" style={{ color: withAlpha(INK, 0.74) }} title={label}>
              {label}
            </span>
          ))}
        </div>
      ) : null}
    </motion.div>
  );
}
