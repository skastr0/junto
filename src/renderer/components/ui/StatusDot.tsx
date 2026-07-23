import { HUE, withAlpha } from "../../lib/theme";

export type StatusTone = "amber" | "cyan" | "crimson" | "green" | "violet" | "steel" | "dim";

const TONE_HEX: Record<StatusTone, string> = {
  amber: HUE.amber,
  cyan: HUE.cyan,
  crimson: HUE.crimson,
  green: "#5FB98E",
  violet: HUE.violet,
  steel: HUE.steel,
  dim: "#8a8378",
};

/**
 * Status dot — one 7px lamp for every live/stale/health signal (replaces
 * the ~8 hand-rolled dots: source dots, save dot, lamps, HUD dots).
 * `pulse` adds the slow house glow for live activity.
 */
export function StatusDot({
  tone,
  pulse = false,
  title,
}: {
  readonly tone: StatusTone;
  readonly pulse?: boolean;
  readonly title?: string;
}) {
  const hex = TONE_HEX[tone];
  return (
    <span
      aria-hidden
      title={title}
      className={pulse ? "vellum-status-dot-pulse" : undefined}
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        flex: "none",
        borderRadius: 999,
        background: hex,
        boxShadow: `0 0 8px ${withAlpha(hex, 0.55)}`,
      }}
    />
  );
}
