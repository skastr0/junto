// Type scale — sizes, tracking and leading. Projected into the `@theme` block
// of theme.generated.css, where Tailwind v4 turns each one into a utility:
// --text-label -> text-label, --tracking-eyebrow -> tracking-eyebrow,
// --leading-body -> leading-body.
//
// The values are the sizes the app already shipped, so adopting a token never
// moves a pixel. Names stay clear of Tailwind's own (text-xs, leading-tight)
// so no default utility changes meaning.

export const TEXT_SIZES: Record<string, string> = {
  // Legacy sizes under review: kept so adoption changes nothing visually.
  // Do not use them in new work.
  micro: "8px",
  caption: "9px",
  // The working scale.
  label: "10px",
  body: "11px",
  "body-lg": "12px",
  title: "14px",
  display: "18px",
};

/** Names in TEXT_SIZES that new work must not reach for. */
export const LEGACY_TEXT_SIZES: readonly string[] = ["micro", "caption"];

export const TRACKING: Record<string, string> = {
  flat: "0",
  label: "0.08em",
  eyebrow: "0.14em",
};

export const LEADING: Record<string, string> = {
  compact: "1.2",
  body: "1.45",
};
