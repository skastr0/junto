import { GradientSpin, type SpinPattern } from "gradient-spin";
import {
  ACTIVITY_TONE_HEX,
  houseGradientStops,
  type ActivityMode,
  type ActivitySize,
  type ActivitySpec,
  type ActivityTone,
} from "../lib/activity";

const SIZE: Record<
  ActivitySize,
  { readonly rows: number; readonly cols: number; readonly cellSize: number; readonly cellGap: number }
> = {
  // Package demo density (4px cells / 2px gap) — smaller cells lose the trail.
  node: { rows: 3, cols: 3, cellSize: 4, cellGap: 2 },
  inline: { rows: 3, cols: 3, cellSize: 3, cellGap: 2 },
};

// Package default. The 2.2s first ship made each phase a discrete pop.
const WAVE_PERIOD_MS = 750;

export type ActivityMarkProps = {
  readonly mode: ActivityMode;
  readonly tone: ActivityTone;
  /** Accessible name only. */
  readonly label: string;
  readonly size?: ActivitySize;
  readonly className?: string;
  /** Wavefront shape when mode=wave. Default "snake" (house established). */
  readonly pattern?: SpinPattern;
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
      pattern={spec.pattern}
      label={spec.label}
      size={size}
      className={className}
    />
  );
}

/**
 * Canvas activity indicator.
 * wave  → monochrome gradient-spin trail (pattern per spec, snake by default)
 * static → single filled dot of the same tone
 * No visible text — label is aria-only.
 *
 * First ship looked bad for config reasons, not snake itself:
 * - period 2200ms → discrete pops (demo is 750ms linear)
 * - colorBy "path" → each cell unique color + sequential light = strobe
 * - snake + colorBy "row" + 750ms = continuous trail like the demo
 */
export function ActivityMark({
  mode,
  tone,
  label,
  size = "node",
  className,
  pattern = "snake",
  active = true,
}: ActivityMarkProps) {
  const hex = ACTIVITY_TONE_HEX[tone];
  const dims = SIZE[size];
  const wave = mode === "wave" && active;

  // Footprint matches the wave grid so mode flips don't shift card chrome.
  const box = dims.cols * dims.cellSize + (dims.cols - 1) * dims.cellGap;
  const boxH = dims.rows * dims.cellSize + (dims.rows - 1) * dims.cellGap;

  if (!wave) {
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

  return (
    <span
      className={className}
      style={{ display: "inline-flex", flexShrink: 0, lineHeight: 0, verticalAlign: "middle" }}
      title={label}
    >
      <GradientSpin
        gradient={[...houseGradientStops(tone)]}
        pattern={pattern}
        rows={dims.rows}
        cols={dims.cols}
        cellSize={dims.cellSize}
        cellGap={dims.cellGap}
        cellRadius={1}
        period={WAVE_PERIOD_MS}
        dim={0}
        colorBy="row"
        label={label}
        respectReducedMotion
      />
    </span>
  );
}
