import { GradientSpin } from "gradient-spin";
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
  // Match gradient-spin demo density (4px cells) so the wavefront reads clean.
  node: { rows: 3, cols: 3, cellSize: 4, cellGap: 2 },
  // List rows / tool chips — still compact, square so ripple stays circular.
  inline: { rows: 3, cols: 3, cellSize: 3, cellGap: 2 },
};

// Demo default is 750ms. Slightly longer for dark instrument chrome without
// the 2.2s crawl that made cells feel like discrete blips.
const WAVE_PERIOD_MS = 900;

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
 * wave  → monochrome gradient-spin (ripple rings, ~900ms — demo-smooth)
 * static → single filled dot of the same tone
 * No visible text — label is aria-only.
 *
 * Why these knobs (vs the awkward first ship):
 * - `ripple` = expanding rings from center (reads circular; snake zigzags/blips)
 * - `colorBy: "row"` = smooth ramp like the package demo (path = one-cell strobes)
 * - period ~900ms near the demo's 750ms (2200ms felt like discrete pops)
 */
export function ActivityMark({
  mode,
  tone,
  label,
  size = "node",
  className,
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
        pattern="ripple"
        rows={dims.rows}
        cols={dims.cols}
        cellSize={dims.cellSize}
        cellGap={dims.cellGap}
        cellRadius={1}
        period={WAVE_PERIOD_MS}
        dim={0.1}
        colorBy="row"
        label={label}
        respectReducedMotion
      />
    </span>
  );
}
