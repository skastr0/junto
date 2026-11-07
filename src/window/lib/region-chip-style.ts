import type { CSSProperties } from "react";
import { regionWordShare } from "./region-word-ink";
import { accentColor } from "./theme";

/**
 * A region's colours as the phone draws them: a preset or hex is the base,
 * a region with no colour of its own the main accent, the open field steel.
 * Ink, tint and halo mix from the base in feed-region-strip.css. A free hex
 * is no preset tuned per theme, so its words take only as much of it as
 * still reads at 4.5:1 in each theme.
 *
 * The region chips set it; a seat chip takes its own region's, so one dot
 * says the same thing on both rows.
 */
export const regionChipStyle = (chip: {
  readonly open: boolean;
  readonly color: string | undefined;
}): CSSProperties => {
  const base = chip.open ? "var(--color-steel)" : accentColor(chip.color);
  if (!base.startsWith("#")) return { "--chip-region": base } as CSSProperties;
  return {
    "--chip-region": base,
    "--chip-share-dark": `${regionWordShare(base, "dark")}%`,
    "--chip-share-bright": `${regionWordShare(base, "bright")}%`,
  } as CSSProperties;
};
