import type { OverlayManifest } from "@shared/overlay-contract";

// The open-source overlay: what `@junto/overlay` resolves to when a build
// sets no JUNTO_OVERLAY. It adds nothing; the app is complete without it.
export const overlay: OverlayManifest = {
  marker: "junto-overlay:oss",
  name: "Open source",
  cosmetics: [],
};
