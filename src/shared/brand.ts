import type { PortraitConfig } from "./agent-portrait";
import { overlayManifest } from "./overlay";
import { normalizePortraitOverride } from "./portrait-overrides";

// The build's mascot, if it has one. Pip and the brand cast are private brand
// content: the official build carries Pip through the overlay's brand entry
// (docs/overlay.md); an open-source build has no mascot and every surface
// that would show one falls back to a plain face.

export interface BrandMascot {
  readonly name: string;
  /** Portrait identity string: fixes gaze, tilt, proportions, and wobble. */
  readonly seed: string;
  /** Pinned traits, so a renderer change never re-rolls the mascot. */
  readonly config: PortraitConfig;
}

const mascot = overlayManifest.brand?.mascot;

export const brandMascot: BrandMascot | undefined = mascot
  ? { name: mascot.name, seed: mascot.seed, config: normalizePortraitOverride(mascot.config) ?? {} }
  : undefined;
