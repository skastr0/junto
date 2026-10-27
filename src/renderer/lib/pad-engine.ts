import { observable } from "@legendapp/state";

/**
 * Which engine draws an artifact pad (dev builds, the Excalidraw spike): our
 * SVG editor or Excalidraw. Held for the session only.
 */
export type PadEngine = "svg" | "excalidraw";

export const padEngine$ = observable<PadEngine>("svg");
