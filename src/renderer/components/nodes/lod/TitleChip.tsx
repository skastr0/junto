import { motion } from "motion/react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { TitleChipData } from "../../../lib/lod/flow-types";
import { accentColor, HUE, INK, withAlpha } from "../../../lib/theme";
import { LOD_MOTION } from "./RegionCard";

const FLAG_HUE: Record<string, string> = { blocker: HUE.crimson, attention: HUE.amber, parked: HUE.violet };
const hiddenHandleStyle = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: "none", background: "transparent", pointerEvents: "none" as const };

// A region-less node at the mid tier: a compact title chip. Just the node's
// name and, if flagged, a single status dot — a quiet placeholder that keeps
// loose nodes present on the map without competing with the emblems.
export function TitleChip({ data }: NodeProps<Node<TitleChipData, "title-chip">>) {
  const flag = data.flags.find((f) => f === "blocker") ?? data.flags[0];
  const dot = flag ? FLAG_HUE[flag] : undefined;
  const tint = data.color ? accentColor(data.color) : undefined;
  return (
    <motion.div
      {...LOD_MOTION}
      className="vellum-lod-chip flex h-full w-full items-center gap-2 overflow-hidden rounded-full px-3"
      style={{
        border: `1px solid ${dot ? withAlpha(dot, 0.4) : withAlpha(INK, 0.14)}`,
        background: "linear-gradient(135deg, rgba(30,25,20,0.82), rgba(13,12,11,0.9))",
        boxShadow: "0 6px 16px rgba(0,0,0,0.24)",
      }}
    >
      <Handle type="target" position={Position.Left} style={hiddenHandleStyle} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={hiddenHandleStyle} isConnectable={false} />
      <span className="size-[5px] shrink-0 rounded-full" style={{ background: dot ?? tint ?? withAlpha(INK, 0.35) }} />
      <span className="truncate text-[10px] uppercase tracking-[0.14em]" style={{ color: withAlpha(INK, 0.82) }} title={data.title}>
        {data.title}
      </span>
    </motion.div>
  );
}
