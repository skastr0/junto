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
