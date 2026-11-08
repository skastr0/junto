import { overlay } from "@junto/overlay";
import { decodeOverlay } from "./overlay-contract";

/**
 * The overlay this build was compiled with, decoded once. An open-source
 * build holds the stub: marker junto-overlay:oss, no cosmetics.
 */
export const overlayManifest = decodeOverlay(overlay);
