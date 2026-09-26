import type { CosmeticPack } from "./pack-schema";

// The free items of the Junto cast, as the built-in cosmetic pack: in the
// open-source code, in every build, and drawn by the same interpreter as the
// premium pack (one path). Four species, every palette, and two basic ears,
// patterns, and props; faces and moods are not cosmetics and are all free, in
// the engine. Pip is a free character. The premium items come from the
// premium folder through the build's overlay, on top of these.
//
// Local coordinates are relative to each part's anchor (see pack-schema.ts);
// with `mirror: "sides"` x is written for the right side and flipped for the
// left. `identity` is the seat-identity draw over the free items; the premium
// pack declares the full one.

export const FREE_PACK_ID = "junto-free";

export const FREE_PACK: CosmeticPack = {
  format: 1,
  id: FREE_PACK_ID,
  name: "Junto free",
  tier: "free",
  palettes: [
    { id: "amber", name: "Amber", token: "amber" },
    { id: "orange", name: "Orange", token: "orange" },
    { id: "green", name: "Green", token: "green" },
    { id: "cyan", name: "Cyan", token: "cyan" },
    { id: "violet", name: "Violet", token: "violet" },
    { id: "indigo", name: "Indigo", token: "indigo" },
    { id: "steel", name: "Steel", token: "steel" },
  ],
  species: [
    {
      id: "round",
      name: "Round",
      body: { n: 2, w: 33, h: 34, cy: 60 },
    },
    {
      id: "bean",
      name: "Bean",
      body: { n: 2.2, w: 28, h: 42, cy: 66 },
    },
    {
      id: "toast",
      name: "Toast",
      body: { n: 3.6, w: 31, h: 36, cy: 62 },
    },
    {
      id: "drop",
      name: "Drop",
      body: {
        n: 2,
        w: 32,
        h: 36,
        cy: 62,
        deform: [
          { kind: "pinchTop", amount: 0.55, power: 3 },
        ],
      },
    },
  ],
  toppers: [
    {
      id: "none",
      name: "None",
      parts: [],
    },
    {
      id: "cat",
      name: "Cat ears",
      parts: [
        {
          layer: "behind",
          anchor: { x: "ear", y: "top" },
          mirror: "sides",
          shapes: [
            { kind: "path", d: "M -9 11 Q 2 -14 5 -13 Q 9 -4 10 13 Z", paint: "inked", color: "body" },
          ],
        },
      ],
    },
    {
      id: "sprout",
      name: "Sprout",
      parts: [
        {
          layer: "front",
          anchor: { x: "center", y: "top" },
          shapes: [
            { kind: "path", d: "M 0 3 L 0 -10", paint: "stroke" },
            { kind: "path", d: "M 0 -8 C -4 -18 -15 -17 -16 -13 C -13 -6 -4 -5 0 -8 Z", paint: "inked", color: "leaf" },
            { kind: "path", d: "M 0 -10 C 3 -20 12 -22 15 -19 C 13 -11 5 -8 0 -10 Z", paint: "inked", color: "leaf" },
          ],
        },
      ],
      crown: true,
    },
  ],
  patterns: [
    {
      id: "none",
      name: "None",
      parts: [],
    },
    {
      id: "belly",
      name: "Belly",
      parts: [
        {
          layer: "body",
          anchor: { x: "center", y: "center" },
          units: "body",
          shapes: [
            { kind: "ellipse", cx: 0, cy: 0.62, rx: 0.62, ry: 0.5, paint: "fill", color: "belly" },
          ],
        },
      ],
    },
    {
      id: "spots",
      name: "Spots",
      parts: [
        {
          layer: "body",
          anchor: { x: "center", y: "center" },
          units: "body",
          shapes: [
            { kind: "circle", cx: -0.7, cy: -0.13, r: 5.5, paint: "fill", color: "shade" },
            { kind: "circle", cx: 0.72, cy: 0.25, r: 6, paint: "fill", color: "shade" },
            { kind: "circle", cx: -0.62, cy: 0.6, r: 4.5, paint: "fill", color: "shade" },
          ],
        },
      ],
    },
  ],
  accessories: [
    {
      id: "none",
      name: "None",
      parts: [],
    },
    {
      id: "beanie",
      name: "Beanie",
      hat: true,
      parts: [
        {
          layer: "hat",
          anchor: { x: "center", y: "top", edgeAt: 9, edgePad: 1.5 },
          units: "span",
          shapes: [
            { kind: "path", d: "M -1 9 C -1 -13 1 -13 1 9 Z", paint: "inked", color: "accent" },
            { kind: "path", d: "M -1.05 4 H 1.05 V 11 H -1.05 Z", paint: "inked", color: "accentShade" },
            { kind: "circle", cx: 0, cy: -9, r: 4.2, paint: "inked", color: "shine" },
          ],
        },
      ],
    },
    {
      id: "glasses",
      name: "Glasses",
      parts: [
        {
          layer: "face",
          anchor: { x: "eye", y: "eye" },
          mirror: "sides",
          shapes: [
            { kind: "circle", cx: 0, cy: 0, r: 6, paint: "stroke", color: "ink", width: 2.1 },
          ],
        },
        {
          layer: "face",
          anchor: { x: "face", y: "eye" },
          units: "eyes",
          shapes: [
            { kind: "path", d: "M -0.55 -1 Q 0 -3.5 0.55 -1", paint: "stroke", color: "ink", width: 2.1 },
          ],
        },
      ],
    },
  ],
  identity: {
    palettes: [
      ["amber", 2],
      ["orange", 2],
      ["green", 2],
      ["cyan", 2],
      ["violet", 2],
      ["indigo", 1],
      ["steel", 1],
    ],
    species: ["round", "bean", "toast", "drop"],
    toppers: ["none", "cat", "sprout"],
    patterns: ["none", "belly", "spots"],
    speciesMore: [],
    toppersMore: [],
    patternsMore: [],
    props: ["beanie", "glasses"],
  },
};
