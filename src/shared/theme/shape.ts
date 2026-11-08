// Corner radius scale. Projected into the `@theme` block of
// theme.generated.css as --radius-*, which Tailwind reads for rounded-sm,
// rounded-md, rounded-lg, rounded-xl and rounded-pill.
//
// sm to xl carry the same lengths as Tailwind's own defaults (0.25rem and up,
// at a 16px root), so a class that already said rounded-md keeps its shape
// and now follows the theme. The app once held 27 radius values; each moves
// to its nearest step here.

export const RADIUS: Record<string, string> = {
  sm: "4px",
  md: "6px",
  lg: "8px",
  xl: "12px",
  // A full capsule: chips, toggles, progress tracks.
  pill: "999px",
};
