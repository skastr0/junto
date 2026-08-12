import type { CSSProperties } from "react";
import { use$ } from "@legendapp/state/react";
import {
  ACTIVITY_TONE_HEX,
  type ActivityMode,
  type ActivitySize,
  type ActivitySpec,
  type ActivityTone,
} from "../lib/activity";
import { surfaceMotionLive$ } from "../lib/surface-motion";

const SIZE: Record<
  ActivitySize,
  { readonly rows: number; readonly cols: number; readonly cellSize: number; readonly cellGap: number }
> = {
  // Package demo density (4px cells / 2px gap) — footprint matches historical grid.
  node: { rows: 3, cols: 3, cellSize: 4, cellGap: 2 },
  inline: { rows: 3, cols: 3, cellSize: 3, cellGap: 2 },
};

/** Clockwise perimeter for the static wave track (decoration only — not animated). */
const CLOCKWISE_CELLS = [
  [1, 1],
  [1, 2],
  [1, 3],
  [2, 3],
  [3, 3],
  [3, 2],
  [3, 1],
  [2, 1],
] as const;

export type ActivityMarkProps = {
  readonly mode: ActivityMode;
  readonly tone: ActivityTone;
  /** Accessible name only. */
  readonly label: string;
  readonly size?: ActivitySize;
  readonly className?: string;
  /** When false, never animate (caller may also pass mode=static). */
  readonly active?: boolean;
};

/** Convenience: pass a full ActivitySpec. */
export function ActivityMarkFromSpec({
  spec,
  size = "node",
  className,
}: {
  readonly spec: ActivitySpec;
  readonly size?: ActivitySize;
  readonly className?: string;
}) {
  return (
    <ActivityMark
      mode={spec.mode}
      tone={spec.tone}
      label={spec.label}
      size={size}
      className={className}
    />
  );
}

/**
 * Canvas activity indicator — at most one continuously animated layer.
 *
 * wave  → static perimeter track + one transform-only head (clockwise)
 * pulse → one soft breath layer (ready/complete — never clockwise)
 * static → single filled dot of the same tone
 *
 * No visible text — label is aria-only. Infinite animation is owned by a
 * single descendant (never a multi-cell grid of independent keyframes).
 */
export function ActivityMark({
  mode,
  tone,
  label,
  size = "node",
  className,
  active = true,
}: ActivityMarkProps) {
  const surfaceLive = use$(surfaceMotionLive$);
  const hex = ACTIVITY_TONE_HEX[tone];
  const dims = SIZE[size];
  // Page hidden / reduced-motion: static tone dot — unmount animated layers
  // entirely when motion is gated (some Electron builds still schedule work
  // under animation-play-state:paused).
  const live = active && surfaceLive;
  const wave = mode === "wave" && live;
  const pulse = mode === "pulse" && live;

  // Footprint matches the historical 3×3 grid so mode flips don't shift chrome.
  const box = dims.cols * dims.cellSize + (dims.cols - 1) * dims.cellGap;
  const boxH = dims.rows * dims.cellSize + (dims.rows - 1) * dims.cellGap;
  const step = dims.cellSize + dims.cellGap;

  const shellStyle: CSSProperties = {
    display: "inline-flex",
    width: box,
    height: boxH,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    lineHeight: 0,
    position: "relative",
    verticalAlign: "middle",
  };

  if (!wave && !pulse) {
    const dot = Math.max(5, Math.min(box, boxH) - 4);
    return (
      <span
        role="status"
        aria-label={label}
        title={label}
        className={className}
        data-activity-mode="static"
        data-activity-tone={tone}
        data-activity-size={size}
        style={shellStyle}
      >
        <span
          className="vellum-activity-static-dot"
          style={{
            display: "inline-block",
            width: dot,
            height: dot,
            borderRadius: 999,
            background: hex,
            boxShadow:
              tone === "green" || tone === "amber" || tone === "cyan"
                ? `0 0 6px ${hex}99`
                : "none",
          }}
        />
      </span>
    );
  }

  if (pulse) {
    return (
      <span
        role="status"
        aria-label={label}
        title={label}
        className={className}
        data-activity-mode="pulse"
        data-activity-tone={tone}
        data-activity-size={size}
        style={shellStyle}
      >
        {/* Exactly one infinite-animated descendant. */}
        <span
          className="vellum-activity-pulse-layer"
          style={{
            display: "block",
            width: box,
            height: boxH,
            borderRadius: 2,
            backgroundColor: hex,
          }}
        />
      </span>
    );
  }

  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={className}
      data-activity-mode="wave"
      data-activity-tone={tone}
      data-activity-size={size}
      style={shellStyle}
    >
      {/* Static track — no infinite animation on these cells. */}
      <span
        className="vellum-activity-wave-track"
        aria-hidden
        style={{
          display: "inline-grid",
          gridTemplateColumns: `repeat(3, ${String(dims.cellSize)}px)`,
          gridTemplateRows: `repeat(3, ${String(dims.cellSize)}px)`,
          gap: dims.cellGap,
          position: "absolute",
          inset: 0,
        }}
      >
        {CLOCKWISE_CELLS.map(([row, column]) => (
          <span
            key={`${String(row)}:${String(column)}`}
            className="vellum-activity-wave-cell"
            style={{
              gridRow: row,
              gridColumn: column,
              width: dims.cellSize,
              height: dims.cellSize,
              borderRadius: 1,
              backgroundColor: hex,
            }}
          />
        ))}
      </span>
      {/* Exactly one infinite-animated descendant — transform only. */}
      <span
        className="vellum-activity-wave-head"
        aria-hidden
        style={
          {
            position: "absolute",
            left: 0,
            top: 0,
            width: dims.cellSize,
            height: dims.cellSize,
            borderRadius: 1,
            backgroundColor: hex,
            "--activity-step": `${String(step)}px`,
          } as CSSProperties
        }
      />
    </span>
  );
}
