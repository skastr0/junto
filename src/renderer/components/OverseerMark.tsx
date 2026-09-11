import { HUE, withAlpha } from "../lib/theme";

/**
 * Glance-only OVERSEER identity. Not a control — grant/revoke lives on the
 * RTS kind strip. Indigo, never amber (attention) or crimson (blocker).
 */
export function OverseerMark({
  size = "card",
}: {
  readonly size?: "card" | "session";
}) {
  const compact = size === "card";
  return (
    <span
      className="overseer-mark"
      data-testid="overseer-mark"
      data-overseer="true"
      data-size={size}
      title="Overseer"
      style={{
        color: HUE.indigo,
        borderColor: withAlpha(HUE.indigo, 0.42),
        background: withAlpha(HUE.indigo, compact ? 0.1 : 0.14),
        fontSize: compact ? 8 : 10,
        letterSpacing: compact ? "0.14em" : "0.16em",
        padding: compact ? "2px 5px" : "3px 7px",
      }}
    >
      OVERSEER
    </span>
  );
}
