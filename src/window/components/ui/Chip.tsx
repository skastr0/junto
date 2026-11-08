import type { ReactNode } from "react";
import { GREEN, HUE, HUE_TEXT, withAlpha } from "../../lib/theme";

export type ChipTone = "amber" | "cyan" | "violet" | "crimson" | "steel" | "green";

/** The mark: the chip's edge and its wash. */
const TONE_HEX: Record<ChipTone, string> = {
  amber: HUE.amber,
  cyan: HUE.cyan,
  violet: HUE.violet,
  crimson: HUE.crimson,
  steel: HUE.steel,
  green: GREEN,
};

/** The word: the hue's text form, the one that clears 4.5 to 1 on the wash. */
const TONE_TEXT: Record<ChipTone, string> = {
  amber: HUE_TEXT.amber,
  cyan: HUE_TEXT.cyan,
  violet: HUE_TEXT.violet,
  crimson: HUE_TEXT.crimson,
  steel: HUE_TEXT.steel,
  green: HUE_TEXT.green,
};

/**
 * Chip — tiny uppercase annotation (state tags, counts). The one treatment
 * for node status tags, WORKING n tags, service pills, etc.
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
      className="inline-flex items-center rounded-sm border px-1.5 py-0.5 text-micro leading-none tracking-eyebrow uppercase select-none"
      style={{
        color: TONE_TEXT[tone],
        borderColor: withAlpha(hex, 0.36),
        background: withAlpha(hex, 0.09),
      }}
    >
      {children}
    </span>
  );
}
