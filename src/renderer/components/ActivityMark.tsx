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
  // Package demo density (4px cells / 2px gap) — smaller cells lose the trail.
  node: { rows: 3, cols: 3, cellSize: 4, cellGap: 2 },
  inline: { rows: 3, cols: 3, cellSize: 3, cellGap: 2 },
};

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

/** Full 3×3 including center — pulse breathes every cell together. */
const PULSE_CELLS = [
  [1, 1],
  [1, 2],
  [1, 3],
  [2, 1],
  [2, 2],
  [2, 3],
  [3, 1],
  [3, 2],
  [3, 3],
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
 * Canvas activity indicator.
 * wave  → deterministic clockwise perimeter trail (work / block / attention)
 * pulse → full grid soft breath (ready/complete — never clockwise)
 * static → single filled dot of the same tone
 * No visible text — label is aria-only.
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
  // Page hidden / reduced-motion: static tone dot — unmount animated cells
  // entirely when motion is gated (some Electron builds still schedule work
  // under animation-play-state:paused).
  const live = active && surfaceLive;
  const wave = mode === "wave" && live;
  const pulse = mode === "pulse" && live;

  // Footprint matches the wave grid so mode flips don't shift card chrome.
  const box = dims.cols * dims.cellSize + (dims.cols - 1) * dims.cellGap;
  const boxH = dims.rows * dims.cellSize + (dims.rows - 1) * dims.cellGap;

  if (!wave && !pulse) {
    const dot = Math.max(5, Math.min(box, boxH) - 4);
    return (
      <span
        role="status"
        aria-label={label}
        title={label}
        className={className}
        style={{
          display: "inline-flex",
          width: box,
          height: boxH,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          lineHeight: 0,
        }}
      >
        <span
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
        className={className}
        style={{
          display: "inline-grid",
          gridTemplateColumns: `repeat(3, ${String(dims.cellSize)}px)`,
          gridTemplateRows: `repeat(3, ${String(dims.cellSize)}px)`,
          gap: dims.cellGap,
          flexShrink: 0,
          lineHeight: 0,
          verticalAlign: "middle",
        }}
        title={label}
      >
        {PULSE_CELLS.map(([row, column]) => (
          <span
            key={`${String(row)}:${String(column)}`}
            className="vellum-activity-pulse-cell"
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
    );
  }

  return (
    <span
      role="status"
      aria-label={label}
      className={className}
      style={{
        display: "inline-grid",
        gridTemplateColumns: `repeat(3, ${String(dims.cellSize)}px)`,
        gridTemplateRows: `repeat(3, ${String(dims.cellSize)}px)`,
        gap: dims.cellGap,
        flexShrink: 0,
        lineHeight: 0,
        verticalAlign: "middle",
      }}
      title={label}
    >
      {CLOCKWISE_CELLS.map(([row, column], step) => (
        <span
          key={`${String(row)}:${String(column)}`}
          className="vellum-activity-clock-cell"
          style={{
            gridRow: row,
            gridColumn: column,
            width: dims.cellSize,
            height: dims.cellSize,
            borderRadius: 1,
            backgroundColor: hex,
            "--activity-clock-step": step,
          } as CSSProperties}
        />
      ))}
    </span>
  );
}
