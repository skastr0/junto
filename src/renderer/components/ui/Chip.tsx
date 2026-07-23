import type { ReactNode } from "react";
import { HUE, withAlpha } from "../../lib/theme";

export type ChipTone = "amber" | "cyan" | "violet" | "crimson" | "steel" | "green";

const TONE_HEX: Record<ChipTone, string> = {
  amber: HUE.amber,
  cyan: HUE.cyan,
  violet: HUE.violet,
  crimson: HUE.crimson,
  steel: HUE.steel,
  green: "#5FB98E",
};

/**
 * Chip — tiny uppercase annotation (flags, state tags, counts). The one
 * treatment for `.vellum-node__flag`, WORKING n tags, service pills, etc.
 */
export function Chip({
  tone,
  title,
  children,
}: {
  readonly tone: ChipTone;
  readonly title?: string;
  readonly children: ReactNode;
}) {
  const hex = TONE_HEX[tone];
  return (
    <span
      title={title}
      className="inline-flex items-center rounded-[3px] border px-1.5 py-0.5 text-[8px] leading-none tracking-[0.13em] uppercase select-none"
      style={{
        color: hex,
        borderColor: withAlpha(hex, 0.36),
        background: withAlpha(hex, 0.09),
      }}
    >
      {children}
    </span>
  );
}
