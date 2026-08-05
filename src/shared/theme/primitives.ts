import type { Oklch } from "./oklch";

// Primitive ramps, per mode. Primitives are never consumed by components —
// semantic.ts assigns them meaning. Dark values are the exact OKLCH
// equivalents of the palette the app ships today (round-trip verified
// lossless at 5 decimals). Bright values are the daylight edition: warm
// paper, never pure white; ink, never pure black; chroma stays toward amber,
// the brand hue.
//
// Hue roles ship up to three variants:
//   base — display: dots, canvas accents, edge paint (saturation allowed)
//   hi   — lit/hover companion
//   fg   — text/icons on resting surfaces (contrast-gated)

export interface NeutralRamp {
  ground: Oklch;
  raise: Oklch;
  "raise-2": Oklch;
  inset: Oklch;
  well: Oklch;
  ink: Oklch;
  "ink-2": Oklch;
  dim: Oklch;
  faint: Oklch;
  umbra: Oklch;
}

export interface HueRamp {
  amber: Oklch;
  "amber-hi": Oklch;
  "amber-fg": Oklch;
  cyan: Oklch;
  "cyan-fg": Oklch;
  crimson: Oklch;
  "crimson-fg": Oklch;
  violet: Oklch;
  steel: Oklch;
  indigo: Oklch;
  gold: Oklch;
  orange: Oklch;
  green: Oklch;
}

export const NEUTRALS: Record<"dark" | "bright", NeutralRamp> = {
  dark: {
    ground: { l: 0.15039, c: 0.00272, h: 67.55 }, // #0c0b0a — never pure black
    raise: { l: 0.18883, c: 0.00925, h: 75.06 }, // #16130f
    "raise-2": { l: 0.18379, c: 0.00518, h: 67.5 }, // #141210
    inset: { l: 0.17963, c: 0.00389, h: 48.5 }, // #131110
    well: { l: 0.1353, c: 0.00322, h: 69.58 }, // #090807
    ink: { l: 0.92716, c: 0.01775, h: 81.33 }, // #ede6da
    "ink-2": { l: 0.80991, c: 0.02376, h: 84.59 }, // #c8c0b0
    dim: { l: 0.61289, c: 0.0183, h: 79.3 }, // #8a8378
    faint: { l: 0.49033, c: 0.03487, h: 90.43 }, // #68604a
    umbra: { l: 0, c: 0, h: 0 }, // shadow source
  },
  bright: {
    ground: { l: 0.945, c: 0.012, h: 85 }, // warm paper — never pure white
    raise: { l: 0.978, c: 0.007, h: 85 }, // panels lift toward light
    "raise-2": { l: 0.966, c: 0.009, h: 85 },
    inset: { l: 0.936, c: 0.011, h: 85 },
    well: { l: 0.908, c: 0.013, h: 85 }, // deepest inset
    ink: { l: 0.3, c: 0.014, h: 65 }, // warm near-black ink
    "ink-2": { l: 0.4, c: 0.014, h: 65 },
    dim: { l: 0.46, c: 0.013, h: 65 },
    faint: { l: 0.53, c: 0.015, h: 70 }, // placeholder legibility floor
    umbra: { l: 0.3, c: 0.02, h: 60 }, // warm shadow source, never pure black
  },
};

export const HUES: Record<"dark" | "bright", HueRamp> = {
  dark: {
    amber: { l: 0.7649, c: 0.13988, h: 72.95 }, // #e8a33d — home hue
    "amber-hi": { l: 0.89239, c: 0.06852, h: 85.73 }, // #f0d9a8
    "amber-fg": { l: 0.7649, c: 0.13988, h: 72.95 }, // base reads fine on dark
    cyan: { l: 0.76048, c: 0.11721, h: 206.31 }, // #39c6d6
    "cyan-fg": { l: 0.76048, c: 0.11721, h: 206.31 },
    crimson: { l: 0.62557, c: 0.19334, h: 23.03 }, // #e5484d — blockers only
    "crimson-fg": { l: 0.62557, c: 0.19334, h: 23.03 },
    violet: { l: 0.64851, c: 0.16258, h: 287.53 }, // #8b7beb
    steel: { l: 0.70421, c: 0.02949, h: 236.38 }, // #8fa3b0
    indigo: { l: 0.63143, c: 0.17645, h: 275.45 }, // #6e7bf2
    gold: { l: 0.75664, c: 0.11885, h: 83.55 }, // #d4a94f
    orange: { l: 0.69551, c: 0.1692, h: 44.1 }, // #f07438
    green: { l: 0.71797, c: 0.10827, h: 161.16 }, // #5fb98e
  },
  bright: {
    // Display variants stay in the same families; fg variants darken to the
    // functional inks of the daylight edition (rust, slate blue, deep red).
    amber: { l: 0.72, c: 0.135, h: 72 },
    "amber-hi": { l: 0.62, c: 0.13, h: 68 },
    "amber-fg": { l: 0.53, c: 0.11, h: 60 }, // burnished rust
    cyan: { l: 0.68, c: 0.09, h: 220 },
    "cyan-fg": { l: 0.48, c: 0.075, h: 225 }, // slate blue
    crimson: { l: 0.56, c: 0.19, h: 25 },
    "crimson-fg": { l: 0.48, c: 0.17, h: 25 }, // deep red
    violet: { l: 0.52, c: 0.13, h: 295 },
    steel: { l: 0.55, c: 0.03, h: 230 },
    indigo: { l: 0.5, c: 0.12, h: 275 },
    gold: { l: 0.62, c: 0.11, h: 80 },
    orange: { l: 0.58, c: 0.15, h: 45 },
    green: { l: 0.55, c: 0.1, h: 160 }, // teal-leaning
  },
};
