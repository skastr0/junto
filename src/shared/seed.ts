import type { CanvasDoc } from "./canvas";

// The starter portfolio canvas written on first launch so the station is
// useful the moment it opens.
//
// PLACEHOLDER — VL-005 replaces this with the real portfolio seed (prism,
// tower, quasar, booth, ether, orbit nodes, a prism-plugins region, and the
// prism-blocks-everything edges).
export const seedCanvasDoc = (): CanvasDoc => ({
  nodes: [
    {
      id: "seed-welcome",
      type: "text",
      text: "# vellum\n\nThe portfolio canvas. Drag, link, flag.",
      x: 0,
      y: 0,
      width: 360,
      height: 140,
    },
  ],
  edges: [],
});

export const SEED_CANVAS_NAME = "portfolio";
