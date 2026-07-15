import { motion } from "motion/react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { Lock, Unlink } from "lucide-react";
import type { RegionCardData } from "../../../lib/lod/flow-types";
import { accentColor, borderColor, HUE, INK, DIM, withAlpha } from "../../../lib/theme";

// The quiet mount every LOD node wears: a short fade + micro-scale, easing out
// with no overshoot. This is the "animate transitions quietly" the tier swap
// asks for — the new representation settles in; nothing bounces.
export const LOD_MOTION = {
  initial: { opacity: 0, scale: 0.965 },
  animate: { opacity: 1, scale: 1 },
  transition: { duration: 0.19, ease: [0.22, 0.61, 0.36, 1] as const },
};

const formatAgo = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

// Hidden attach points so a bundled edge can terminate on the emblem without a
// visible handle — the emblem reads as one solid stamp, not a wired node.
const hiddenHandleStyle = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: "none", background: "transparent", pointerEvents: "none" as const };

// A region collapsed to its own emblem: the region's name, the load it carries,
// and its kernel posture. Styled off the GroupNode idiom (translucent tint,
// hairline border in the region's colour, rounded rect) so it reads as the
// region's quiet stamp rather than a generic badge.
export function RegionCard({ data, selected }: NodeProps<Node<RegionCardData, "region-card">>) {
  const agg = data.aggregate;
  const tint = accentColor(agg.color);
  const blocked = agg.blockerCount > 0;
  const border = blocked ? withAlpha(HUE.crimson, 0.42) : borderColor(agg.color, selected);
  const readout: string[] = [`${agg.memberCount} node${agg.memberCount === 1 ? "" : "s"}`];
  if (agg.activeGlyphs > 0) readout.push(`${agg.activeGlyphs} active`);
  if (agg.blockerCount > 0) readout.push(`${agg.blockerCount} blocked`);
  const posture: string[] = [];
  if (agg.boundCount > 0) posture.push(`${agg.boundCount} live`);
  if (agg.lastPulseAt) posture.push(`pulsed ${formatAgo(agg.lastPulseAt, Date.now())}`);

  return (
    <motion.div
      {...LOD_MOTION}
      className="vellum-lod-card relative flex h-full w-full cursor-pointer flex-col justify-between rounded-[13px] px-3.5 py-3"
      style={{
        border: `1px solid ${selected ? withAlpha(blocked ? HUE.crimson : tint, 0.7) : border}`,
        background: blocked
          ? `linear-gradient(135deg, ${withAlpha(HUE.crimson, 0.1)}, rgba(13,12,11,0.6))`
          : `linear-gradient(135deg, ${withAlpha(tint, 0.09)}, rgba(13,12,11,0.55))`,
        boxShadow: selected ? `0 0 0 1px ${withAlpha(tint, 0.2)}, 0 14px 34px rgba(0,0,0,0.34)` : "0 12px 30px rgba(0,0,0,0.26)",
      }}
    >
      <Handle type="target" position={Position.Left} style={hiddenHandleStyle} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={hiddenHandleStyle} isConnectable={false} />
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[9px] uppercase tracking-[0.2em]" style={{ color: withAlpha(tint, 0.72) }}>region</span>
          <span className="flex items-center gap-1.5">
            {agg.orphaned ? <span title="armed on a region that no longer resolves"><Unlink size={9} style={{ color: HUE.crimson, opacity: 0.85 }} /></span> : null}
            {agg.armed ? <span className="vellum-armed-dot" title="armed — pulses spend real agent turns" style={{ background: HUE.amber }} /> : null}
            {agg.boundCount > 0 && agg.memberCount > 0 ? <Lock size={9} style={{ color: INK, opacity: 0.28 }} /> : null}
          </span>
        </div>
        <div
          className="mt-1.5 truncate text-[15px] font-semibold uppercase leading-none"
          style={{ color: agg.color ? tint : INK, letterSpacing: "0.06em", fontFamily: '"Arial Narrow", "Avenir Next Condensed", ui-monospace, monospace' }}
          title={agg.title}
        >
          {agg.title}
        </div>
      </div>
      <div className="min-w-0">
        <div className="truncate text-[11px] leading-snug tabular-nums" style={{ color: blocked ? withAlpha(HUE.crimson, 0.9) : DIM }} title={readout.join(" · ")}>
          {readout.join(" · ")}
        </div>
        {posture.length > 0 ? (
          <div className="mt-0.5 truncate text-[9px] uppercase leading-snug tracking-[0.14em]" style={{ color: withAlpha(INK, 0.34) }} title={posture.join(" · ")}>
            {posture.join(" · ")}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}
