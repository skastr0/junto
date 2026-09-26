import type { PortraitConfig, PortraitFace } from "./agent-portrait";
import { EXPRESSION_FACES } from "./portrait-expression";

// The Junto mascot: Pip, one of the cast, drawn by the same portrait renderer
// every seat uses. Pip is a small amber round critter with a sprout, the home
// hue carrying a leaf: a pip is the seed a fruit grows from, and Junto is a
// place where small workers grow into a crew. Brand surfaces (app icon, DMG,
// landing, motion) read Pip from here, never from a copy.

export interface BrandMascot {
  readonly name: string;
  /** Portrait identity string: fixes gaze, tilt, proportions, and wobble. */
  readonly seed: string;
  /** Overrides that pin the traits, so a renderer change never re-rolls Pip. */
  readonly config: PortraitConfig;
}

export const JUNTO_MASCOT: BrandMascot = {
  name: "Pip",
  seed: "pip",
  config: {
    bodyHue: "amber",
    accentHue: "gold",
    shape: "round",
    topper: "sprout",
    eyes: "oval",
    mouth: "smile",
    brows: "none",
    marking: "none",
    accessory: "none",
    blush: true,
    temperament: 0.6,
  },
};

/** The brand expression set, in display order. */
export const BRAND_EXPRESSIONS = ["happy", "working", "curious", "sleepy", "celebrating"] as const;
export type BrandExpression = (typeof BRAND_EXPRESSIONS)[number];

/** Brand expressions are the app's own faces under brand names. */
export const BRAND_FACES: Readonly<Record<BrandExpression, PortraitFace>> = {
  happy: EXPRESSION_FACES.happy,
  working: EXPRESSION_FACES.focused,
  curious: EXPRESSION_FACES.curious,
  sleepy: EXPRESSION_FACES.sleepy,
  celebrating: EXPRESSION_FACES.delighted,
};

/** A brand character: an identity string plus every trait pinned. */
export interface BrandCharacter {
  readonly seed: string;
  readonly config: PortraitConfig;
}

// The brand cast: 24 of the crew, picked for spread of species, hue, and
// props, with every trait written out so a renderer re-roll never moves them.
// Pip is never one of them.
export const BRAND_CAST: ReadonlyArray<BrandCharacter> = [
  {
    seed: "junto-1",
    config: { bodyHue: "amber", accentHue: "orange", shape: "pear", topper: "cat", eyes: "oval", mouth: "wobble", marking: "spots", accessory: "bowtie", blush: true, temperament: 0.03 },
  },
  {
    seed: "junto-3",
    config: { bodyHue: "violet", accentHue: "green", shape: "shroom", topper: "twin", eyes: "oval", mouth: "cat", marking: "stripes", accessory: "none", blush: false, temperament: -0.44 },
  },
  {
    seed: "junto-8",
    config: { bodyHue: "violet", accentHue: "cyan", shape: "cloud", topper: "unicorn", eyes: "sparkle", mouth: "flat", marking: "belly", accessory: "headphones", blush: false, temperament: -0.12 },
  },
  {
    seed: "junto-12",
    config: { bodyHue: "green", accentHue: "orange", shape: "toast", topper: "antlers", eyes: "sleepy", mouth: "grin", marking: "belly", accessory: "party", blush: true, temperament: 0.48 },
  },
  {
    seed: "junto-14",
    config: { bodyHue: "violet", accentHue: "green", shape: "shroom", topper: "bear", eyes: "dot", mouth: "none", marking: "freckles", accessory: "none", blush: false, temperament: 0.24 },
  },
  {
    seed: "junto-17",
    config: { bodyHue: "green", accentHue: "amber", shape: "toast", topper: "cat", eyes: "sparkle", mouth: "cat", marking: "blaze", accessory: "none", blush: false, temperament: 0.2 },
  },
  {
    seed: "junto-22",
    config: { bodyHue: "indigo", accentHue: "green", shape: "peach", topper: "gills", eyes: "sleepy", mouth: "cat", marking: "none", accessory: "wizard", blush: true, temperament: 0.59 },
  },
  {
    seed: "junto-27",
    config: { bodyHue: "indigo", accentHue: "gold", shape: "pear", topper: "tuft", eyes: "shiny", mouth: "wobble", marking: "stripes", accessory: "headphones", blush: true, temperament: 0.41 },
  },
  {
    seed: "junto-29",
    config: { bodyHue: "steel", accentHue: "cyan", shape: "onigiri", topper: "twin", eyes: "oval", mouth: "fang", marking: "cap", accessory: "bowtie", blush: false, temperament: -0.56 },
  },
  {
    seed: "junto-31",
    config: { bodyHue: "indigo", accentHue: "amber", shape: "pear", topper: "bunny", eyes: "oval", mouth: "smile", marking: "heart", accessory: "wizard", blush: true, temperament: -0.32 },
  },
  {
    seed: "junto-38",
    config: { bodyHue: "amber", accentHue: "orange", shape: "gumdrop", topper: "floppy", eyes: "happy", mouth: "o", marking: "none", accessory: "beanie", blush: true, temperament: 0.48 },
  },
  {
    seed: "junto-46",
    config: { bodyHue: "green", accentHue: "cyan", shape: "shroom", topper: "twin", eyes: "oval", mouth: "cat", marking: "freckles", accessory: "beret", blush: true, temperament: -0.54 },
  },
  {
    seed: "junto-50",
    config: { bodyHue: "green", accentHue: "cyan", shape: "peach", topper: "floppy", eyes: "shiny", mouth: "smile", marking: "heart", accessory: "none", blush: true, temperament: 0.01 },
  },
  {
    seed: "junto-54",
    config: { bodyHue: "violet", accentHue: "cyan", shape: "ghost", topper: "bear", eyes: "wink", mouth: "none", marking: "belly", accessory: "headphones", blush: false, temperament: 0.23 },
  },
  {
    seed: "junto-58",
    config: { bodyHue: "cyan", accentHue: "orange", shape: "bean", topper: "mouse", eyes: "dot", mouth: "smile", marking: "cap", accessory: "party", blush: true, temperament: 0.45 },
  },
  {
    seed: "junto-61",
    config: { bodyHue: "green", accentHue: "orange", shape: "drop", topper: "mouse", eyes: "sleepy", mouth: "wobble", marking: "patch", accessory: "glasses", blush: false, temperament: 0.06 },
  },
  {
    seed: "junto-73",
    config: { bodyHue: "amber", accentHue: "orange", shape: "peach", topper: "bear", eyes: "sparkle", mouth: "grin", marking: "spots", accessory: "none", blush: false, temperament: -0.42 },
  },
  {
    seed: "junto-79",
    config: { bodyHue: "amber", accentHue: "cyan", shape: "cloud", topper: "crest", eyes: "wink", mouth: "flat", marking: "cap", accessory: "none", blush: true, temperament: 0.41 },
  },
  {
    seed: "junto-81",
    config: { bodyHue: "steel", accentHue: "orange", shape: "bean", topper: "halo", eyes: "sparkle", mouth: "smile", marking: "heart", accessory: "glasses", blush: true, temperament: -0.03 },
  },
  {
    seed: "junto-89",
    config: { bodyHue: "steel", accentHue: "violet", shape: "mochi", topper: "mouse", eyes: "happy", mouth: "wobble", marking: "belly", accessory: "none", blush: true, temperament: 0 },
  },
  {
    seed: "junto-103",
    config: { bodyHue: "amber", accentHue: "violet", shape: "ghost", topper: "bunny", eyes: "sparkle", mouth: "o", marking: "freckles", accessory: "none", blush: false, temperament: -0.57 },
  },
  {
    seed: "junto-116",
    config: { bodyHue: "amber", accentHue: "cyan", shape: "cloud", topper: "antenna", eyes: "line", mouth: "wobble", marking: "freckles", accessory: "none", blush: false, temperament: 0.03 },
  },
  {
    seed: "junto-123",
    config: { bodyHue: "indigo", accentHue: "orange", shape: "gumdrop", topper: "mouse", eyes: "sparkle", mouth: "o", marking: "heart", accessory: "none", blush: true, temperament: -0.06 },
  },
  {
    seed: "junto-139",
    config: { bodyHue: "cyan", accentHue: "gold", shape: "onigiri", topper: "tuft", eyes: "line", mouth: "fang", marking: "patch", accessory: "none", blush: true, temperament: -0.37 },
  },
];
