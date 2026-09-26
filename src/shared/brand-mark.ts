import { themeRuntime, type ThemeMode } from "./theme";

// The open-source Junto mark: a seat ring around a seat. Twelve amber
// segments (the activity ring every agent seat wears) around a solid dot. No
// character: an open-source build has no mascot, and this mark stands in for
// one on the app icon, the DMG, and the tour. Colors come from the theme.

const SEGMENTS = 12;
const RING_R = 34;
const RING_W = 8;
const DOT_R = 15;

/** The mark as an SVG document on a transparent 100 x 100 box. */
export function juntoMarkSvg(mode: ThemeMode): string {
  const theme = themeRuntime(mode);
  const circumference = 2 * Math.PI * RING_R;
  const step = circumference / SEGMENTS;
  const dash = step * 0.56;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`,
    `<circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="${theme.amber}" stroke-width="${RING_W}"`,
    ` stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${(step - dash).toFixed(2)}"`,
    ` transform="rotate(${(-90 - (dash / circumference) * 180).toFixed(2)} 50 50)"/>`,
    `<circle cx="50" cy="50" r="${DOT_R}" fill="${theme.ink}"/>`,
    `</svg>`,
  ].join("");
}

export const juntoMarkDataUri = (mode: ThemeMode): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(juntoMarkSvg(mode))}`;
