// The mascot as the video sees it: the brand's elected character and faces
// (src/shared/brand-mascot.ts), never a fork of the character code.
import type { PortraitConfig, PortraitFace } from "../../src/shared/agent-portrait";
import { BRAND_FACES, JUNTO_MASCOT, type BrandExpression } from "../../src/shared/brand-mascot";

export type VideoMascot = {
  readonly name: string;
  readonly seed: string;
  readonly config: PortraitConfig;
  readonly faces: Readonly<Record<BrandExpression, PortraitFace>>;
};

export const VIDEO_MASCOT: VideoMascot = {
  name: JUNTO_MASCOT.name,
  seed: JUNTO_MASCOT.seed,
  config: JUNTO_MASCOT.config,
  faces: BRAND_FACES,
};
