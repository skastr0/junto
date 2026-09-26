import type { CosmeticPack, CosmeticPart, CosmeticShape } from "./pack-schema";

// The base cast, as the built-in cosmetic pack. Open source, always present,
// and drawn by the same interpreter as any other pack: one path, not two.
// Local coordinates are relative to each part's anchor (see pack-schema.ts);
// with `mirror: "sides"` x is written for the right side and flipped for the
// left. Order within each list is the identity draw order and never changes.

export const BASE_PACK_ID = "junto-base";

const path = (d: string, paint: CosmeticShape["paint"], color?: CosmeticShape["color"], extra: Partial<CosmeticShape> = {}): CosmeticShape =>
  ({ kind: "path", d, paint, ...(color ? { color } : {}), ...extra }) as CosmeticShape;
const circle = (cx: number, cy: number, r: number, paint: CosmeticShape["paint"], color?: CosmeticShape["color"], extra: Partial<CosmeticShape> = {}): CosmeticShape =>
  ({ kind: "circle", cx, cy, r, paint, ...(color ? { color } : {}), ...extra }) as CosmeticShape;
const ellipse = (cx: number, cy: number, rx: number, ry: number, paint: CosmeticShape["paint"], color?: CosmeticShape["color"], extra: Partial<CosmeticShape> = {}): CosmeticShape =>
  ({ kind: "ellipse", cx, cy, rx, ry, paint, ...(color ? { color } : {}), ...extra }) as CosmeticShape;

const crown = { x: "center", y: "top" } as const;
const ear = { x: "ear", y: "top" } as const;
const r1 = (value: number): number => Math.round(value * 10) / 10;

/** A four-point sparkle star centered at (x, y). */
const star = (x: number, y: number, q: number): string => {
  const k = q * 0.2;
  return `M ${r1(x)} ${r1(y - q)} Q ${r1(x + k)} ${r1(y - k)} ${r1(x + q)} ${r1(y)} Q ${r1(x + k)} ${r1(y + k)} ${r1(x)} ${r1(y + q)} Q ${r1(x - k)} ${r1(y + k)} ${r1(x - q)} ${r1(y)} Q ${r1(x - k)} ${r1(y - k)} ${r1(x)} ${r1(y - q)} Z`;
};

// Axolotl gills: three fronds fanning up and out from the side of the head.
const gillFronds = [
  [-49, 9],
  [-35, 11],
  [-21, 9],
].map(([angle, len], k) => {
  const a = ((angle as number) * Math.PI) / 180;
  const y = 14 + k * 4;
  return path(`M 0 ${y} L ${r1(Math.cos(a) * (len as number))} ${r1(y + Math.sin(a) * (len as number))}`, "line", "blush", { width: 3.2 });
});

const daisy = [0, 72, 144, 216, 288].map((angle) => {
  const a = (angle * Math.PI) / 180;
  return circle(r1(Math.cos(a) * 4.6), r1(4 + Math.sin(a) * 4.6), 3.6, "inked", "shine");
});

const topper = (id: string, name: string, parts: ReadonlyArray<CosmeticPart>, crownSeat = false) => ({
  id,
  name,
  parts,
  ...(crownSeat ? { crown: true } : {}),
});

export const BASE_PACK: CosmeticPack = {
  format: 1,
  id: BASE_PACK_ID,
  name: "Junto cast",
  tier: "base",
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
    { id: "round", name: "Round", body: { n: 2, w: 33, h: 34, cy: 60 } },
    { id: "bean", name: "Bean", body: { n: 2.2, w: 28, h: 42, cy: 66 } },
    { id: "mochi", name: "Mochi", body: { n: 2.8, w: 38, h: 30, cy: 66 } },
    { id: "toast", name: "Toast", body: { n: 3.6, w: 31, h: 36, cy: 62 } },
    { id: "drop", name: "Drop", body: { n: 2, w: 32, h: 36, cy: 62, deform: [{ kind: "pinchTop", amount: 0.55, power: 3 }] } },
    { id: "pear", name: "Pear", body: { n: 2.2, w: 31, h: 38, cy: 64, deform: [{ kind: "pear", amount: 0.14 }] } },
    {
      id: "cloud",
      name: "Cloud",
      body: { n: 2.3, w: 35, h: 31, cy: 64, steps: 56, deform: [{ kind: "scallopTop", lobes: 3.5, depth: 0.07 }] },
    },
    {
      id: "gumdrop",
      name: "Gumdrop",
      body: {
        n: 2,
        w: 32,
        h: 35,
        cy: 62,
        steps: 56,
        deform: [
          { kind: "flattenBase", exponent: 0.55 },
          { kind: "pinchTop", amount: 0.18, power: 2 },
        ],
      },
      parts: [
        {
          layer: "front",
          anchor: crown,
          units: "body",
          shapes: [
            circle(-0.45, 0.35, 1.1, "fill", "shine", { opacity: 0.8 }),
            circle(0.5, 0.1, 1.1, "fill", "shine", { opacity: 0.8 }),
            circle(0.2, 0.62, 1.1, "fill", "shine", { opacity: 0.8 }),
            circle(-0.15, 0.05, 1.1, "fill", "shine", { opacity: 0.8 }),
          ],
        },
      ],
    },
    {
      id: "onigiri",
      name: "Onigiri",
      body: { n: 2.6, w: 37, h: 34, cy: 63, steps: 56, deform: [{ kind: "taper", amount: 0.48, scale: 1.08 }] },
      parts: [
        {
          layer: "body",
          anchor: { x: "center", y: "center" },
          units: "body",
          shapes: [path("M -0.42 0.46 H 0.42 V 1.46 H -0.42 Z", "fill", "ink", { opacity: 0.88 })],
        },
      ],
    },
    {
      id: "ghost",
      name: "Ghost",
      body: { n: 2, w: 31, h: 38, cy: 60, steps: 56, deform: [{ kind: "hem", from: 0.55, waves: 9, depth: 0.05 }] },
      floats: true,
    },
    {
      id: "shroom",
      name: "Shroom",
      body: { n: 2.2, w: 28, h: 31, cy: 69, steps: 56 },
      coversToppers: true,
      coversHats: true,
      parts: [
        {
          layer: "front",
          anchor: crown,
          units: "bodyX",
          shapes: [
            path("M -1.42 13 C -1.42 -16 1.42 -16 1.42 13 Q 0 6 -1.42 13 Z", "inked", "accent"),
            circle(-0.71, 2.4, 4.2, "fill", "shine"),
            circle(0.5, -3, 3.4, "fill", "shine"),
            circle(0.07, 6.6, 2.6, "fill", "shine"),
          ],
        },
      ],
    },
    {
      id: "peach",
      name: "Peach",
      body: { n: 2, w: 34, h: 33, cy: 62, steps: 56, deform: [{ kind: "cleft", depth: 0.13, width: 0.14 }] },
      parts: [
        {
          layer: "front",
          anchor: crown,
          shapes: [
            path("M 0 4 Q -1.5 12 -4 17", "stroke", "shade", { width: 2.7 }),
            path("M 1 3 C 4 -7 13 -8 15 -5 C 12 1 5 4 1 3 Z", "inked", "leaf"),
          ],
        },
      ],
    },
  ],
  toppers: [
    topper("none", "None", []),
    topper("cat", "Cat ears", [
      { layer: "behind", anchor: ear, mirror: "sides", shapes: [path("M -9 11 Q 2 -14 5 -13 Q 9 -4 10 13 Z", "inked", "body")] },
    ]),
    topper("bear", "Bear ears", [
      {
        layer: "behind",
        anchor: ear,
        mirror: "sides",
        shapes: [circle(0, 3, 8.5, "inked", "body"), circle(0, 3, 4, "fill", "shade")],
      },
    ]),
    topper("bunny", "Bunny ears", [
      {
        layer: "behind",
        anchor: { ...ear, dx: -5 },
        mirror: "sides",
        rotate: 7,
        pivot: [0, 6],
        shapes: [
          path("M -6 8 C -8 -16 -4 -26 0 -26 C 4 -26 8 -16 6 8 Z", "inked", "body"),
          path("M 0 -18 L 0 2", "stroke", "shade", { width: 4.2 }),
        ],
      },
    ]),
    topper(
      "antenna",
      "Antenna",
      [
        {
          layer: "front",
          anchor: crown,
          shapes: [path("M 0 2 Q 1 -9 6 -13", "stroke"), circle(6, -15, 5, "inked", "accent")],
        },
      ],
      true,
    ),
    topper(
      "sprout",
      "Sprout",
      [
        {
          layer: "front",
          anchor: crown,
          shapes: [
            path("M 0 3 L 0 -10", "stroke"),
            path("M 0 -8 C -4 -18 -15 -17 -16 -13 C -13 -6 -4 -5 0 -8 Z", "inked", "leaf"),
            path("M 0 -10 C 3 -20 12 -22 15 -19 C 13 -11 5 -8 0 -10 Z", "inked", "leaf"),
          ],
        },
      ],
      true,
    ),
    topper("horns", "Horns", [
      {
        layer: "behind",
        anchor: { ...ear, dx: -6 },
        mirror: "sides",
        shapes: [path("M -5 7 Q 1 -6 7 -10 Q 5 1 5 8 Z", "inked", "belly")],
      },
    ]),
    topper("tuft", "Tuft", [{ layer: "front", anchor: crown, shapes: [path("M -6 3 Q -8 -7 -2 -9 M 0 3 Q 1 -10 8 -8", "stroke")] }], true),
    topper(
      "twin",
      "Twin antennae",
      [
        {
          layer: "front",
          anchor: crown,
          mirror: "sides",
          shapes: [path("M 5 3 L 11 -10", "stroke"), circle(11, -12, 3.8, "inked", "accent")],
        },
      ],
      true,
    ),
    topper("floppy", "Floppy ears", [
      {
        layer: "front",
        anchor: { x: "edge", y: "top", edgeAt: 12, edgePad: -2 },
        mirror: "sides",
        rotate: 14,
        pivot: [0, 6],
        shapes: [path("M -6.5 3 C -9 16 -6 29 0 29 C 6 29 9 16 6.5 3 Z", "inked", "shade")],
      },
    ]),
    topper("mouse", "Mouse ears", [
      {
        layer: "behind",
        anchor: { ...ear, dx: 2 },
        mirror: "sides",
        shapes: [circle(0, 1, 11.5, "inked", "body"), circle(0, 1, 6.5, "fill", "blush", { opacity: 0.6 })],
      },
    ]),
    topper(
      "unicorn",
      "Unicorn horn",
      [
        {
          layer: "front",
          anchor: crown,
          shapes: [
            path("M -5 4 L 1 -20 L 5 4 Z", "inked", "spark"),
            path("M -3 -3 L 3.6 -6 M -1.4 -10 L 2.6 -12", "stroke", "ink", { width: 1.8 }),
          ],
        },
      ],
      true,
    ),
    topper("devil", "Devil horns", [
      { layer: "behind", anchor: { ...ear, dx: -7 }, mirror: "sides", shapes: [path("M -4 6 L 3 -9 L 4 6 Z", "inked", "accent")] },
    ]),
    topper("gills", "Gills", [
      { layer: "behind", anchor: { x: "edge", y: "top", edgeAt: 14, edgePad: -1 }, mirror: "sides", shapes: gillFronds },
    ]),
    topper("antlers", "Antlers", [
      {
        layer: "behind",
        anchor: { ...crown, dx: 9 },
        mirror: "sides",
        shapes: [path("M 0 4 L 5 -12 M 3 -5 L 10 -9 M 5 -12 L 2 -18", "line", "wood", { width: 3 })],
      },
    ]),
    topper("flower", "Flower", [
      {
        layer: "front",
        anchor: { x: "edge", y: "top", edgeAt: 8, edgeScale: 0.62 },
        shapes: [...daisy, circle(0, 4, 3, "inked", "spark")],
      },
    ]),
    topper(
      "halo",
      "Halo",
      [{ layer: "front", anchor: crown, shapes: [ellipse(0, -10, 13, 4, "line", "spark", { width: 3 })] }],
      true,
    ),
    topper(
      "bow",
      "Bow",
      [
        {
          layer: "front",
          anchor: { x: "edge", y: "top", dy: 3, edgeAt: 8, edgeScale: 0.55 },
          mirror: "local",
          shapes: [path("M 0 0 L 9 -6 Q 11 0 9 6 Z", "inked", "accent")],
        },
        {
          layer: "front",
          anchor: { x: "edge", y: "top", dy: 3, edgeAt: 8, edgeScale: 0.55 },
          shapes: [circle(0, 0, 2.8, "inked", "accentShade")],
        },
      ],
      true,
    ),
    topper(
      "crest",
      "Crest",
      [
        {
          layer: "front",
          anchor: crown,
          shapes: [
            path("M -5.9 4 Q -10 -10 -9.1 -12 Q -5 -3 -1.1 4 Z", "inked", "accent"),
            path("M -2.4 4 Q -3 -15 0 -17 Q 2 -3 2.4 4 Z", "inked", "accent"),
            path("M 1.1 4 Q 4 -10 9.1 -12 Q 9 -3 5.9 4 Z", "inked", "accent"),
          ],
        },
      ],
      true,
    ),
  ],
  patterns: [
    { id: "none", name: "None", parts: [] },
    {
      id: "belly",
      name: "Belly",
      parts: [{ layer: "body", anchor: { x: "center", y: "center" }, units: "body", shapes: [ellipse(0, 0.62, 0.62, 0.5, "fill", "belly")] }],
    },
    {
      id: "spots",
      name: "Spots",
      parts: [
        {
          layer: "body",
          anchor: { x: "center", y: "center" },
          units: "body",
          shapes: [circle(-0.7, -0.13, 5.5, "fill", "shade"), circle(0.72, 0.25, 6, "fill", "shade"), circle(-0.62, 0.6, 4.5, "fill", "shade")],
        },
      ],
    },
    {
      id: "cap",
      name: "Cap",
      parts: [{ layer: "body", anchor: crown, units: "body", shapes: [path("M -2 -1 H 2 V 0.34 Q 0 0.52 -2 0.34 Z", "fill", "shade")] }],
    },
    {
      id: "freckles",
      name: "Freckles",
      parts: [
        {
          layer: "body",
          anchor: { x: "face", y: "eye" },
          mirror: "sides",
          shapes: [circle(13, 8, 1, "fill", "shade"), circle(15.6, 10.2, 1, "fill", "shade"), circle(18.2, 8, 1, "fill", "shade")],
        },
      ],
    },
    {
      id: "stripes",
      name: "Stripes",
      parts: [12, 22, 32].map(
        (at): CosmeticPart => ({
          layer: "body",
          anchor: { x: "edge", y: "top", dy: at, edgeAt: at, edgePad: 2 },
          mirror: "sides",
          shapes: [path("M 0 -3 Q -9 0 0 3 Z", "fill", "shade")],
        }),
      ),
    },
    {
      id: "patch",
      name: "Eye patch",
      parts: [{ layer: "body", anchor: { x: "face", y: "eye" }, shapes: [ellipse(11, 0, 9, 8, "fill", "shade")] }],
    },
    {
      id: "muzzle",
      name: "Muzzle",
      parts: [{ layer: "body", anchor: { x: "face", y: "eye" }, shapes: [ellipse(0, 11, 12, 8.5, "fill", "belly")] }],
    },
    {
      id: "blaze",
      name: "Blaze",
      parts: [{ layer: "body", anchor: { x: "face", y: "top" }, shapes: [path("M -4 -2 Q 0 24 4 -2 Z", "fill", "belly")] }],
    },
    {
      id: "stars",
      name: "Stars",
      parts: [
        {
          layer: "body",
          anchor: { x: "center", y: "center" },
          shapes: [
            path(star(-19, -12.6, 3.2), "fill", "shine", { opacity: 0.85 }),
            path(star(20, 1.8, 3.6), "fill", "shine", { opacity: 0.85 }),
            path(star(-17.6, 16.2, 2.8), "fill", "shine", { opacity: 0.85 }),
          ],
        },
      ],
    },
    {
      id: "heart",
      name: "Heart",
      parts: [
        {
          layer: "body",
          anchor: { x: "center", y: "center", dx: 13.4, dy: 15 },
          shapes: [path("M 0 3.6 C -6 -0.6 -3.4 -5.4 0 -2.4 C 3.4 -5.4 6 -0.6 0 3.6 Z", "fill", "blush")],
        },
      ],
    },
  ],
  accessories: [
    { id: "none", name: "None", parts: [] },
    {
      id: "beanie",
      name: "Beanie",
      hat: true,
      parts: [
        {
          layer: "hat",
          anchor: { ...crown, edgeAt: 9, edgePad: 1.5 },
          units: "span",
          shapes: [
            path("M -1 9 C -1 -13 1 -13 1 9 Z", "inked", "accent"),
            path("M -1.05 4 H 1.05 V 11 H -1.05 Z", "inked", "accentShade"),
            circle(0, -9, 4.2, "inked", "shine"),
          ],
        },
      ],
    },
    {
      id: "party",
      name: "Party hat",
      hat: true,
      parts: [
        {
          layer: "hat",
          anchor: crown,
          shapes: [
            path("M -10 5 L 4 -22 L 11 3 Z", "inked", "accent"),
            path("M -6 -2 L 9.5 -4 M -1.5 -11 L 7.4 -12", "stroke", "shine", { width: 2.2 }),
            circle(4, -23, 3.4, "inked", "spark"),
          ],
        },
      ],
    },
    {
      id: "crown",
      name: "Crown",
      hat: true,
      parts: [
        {
          layer: "hat",
          anchor: crown,
          shapes: [
            path("M -13 6 L -15 -8 L -7 -1 L 0 -11 L 7 -1 L 15 -8 L 13 6 Z", "inked", "spark"),
            circle(0, 2, 2.3, "fill", "accent"),
          ],
        },
      ],
    },
    {
      id: "wizard",
      name: "Wizard hat",
      hat: true,
      parts: [
        {
          layer: "hat",
          anchor: crown,
          shapes: [
            path("M -12 4 Q -4 -16 10 -26 Q 4 -12 12 4 Z", "inked", "accent"),
            path("M -22 6 Q 0 -1 22 6 Q 0 11 -22 6 Z", "inked", "accentShade"),
            path("M 1 -11 L 2.2 -8.4 L 5 -8.1 L 2.9 -6.2 L 3.5 -3.4 L 1 -4.8 L -1.5 -3.4 L -0.9 -6.2 L -3 -8.1 L -0.2 -8.4 Z", "fill", "spark"),
          ],
        },
      ],
    },
    {
      id: "beret",
      name: "Beret",
      hat: true,
      parts: [
        {
          layer: "hat",
          anchor: crown,
          shapes: [
            path("M -19 6 Q -16 -9 4 -8 Q 20 -6 17 5 Q 0 9 -19 6 Z", "inked", "accent"),
            path("M 2 -8 L 3 -12", "line", "accent", { width: 2.2 }),
          ],
        },
      ],
    },
    {
      id: "headphones",
      name: "Headphones",
      parts: [
        {
          layer: "hat",
          anchor: { x: "center", y: "eye", dy: -2, edgePad: 2 },
          units: "span",
          shapes: [path("M -0.93 -4 C -1 -32 1 -32 0.93 -4", "line", "accentShade", { width: 2.6 })],
        },
        {
          layer: "hat",
          anchor: { x: "edge", y: "eye", dy: -2, edgePad: 2 },
          mirror: "sides",
          shapes: [path("M -4 -7 H 4 V 7 H -4 Z", "inked", "accent")],
        },
      ],
    },
    {
      id: "glasses",
      name: "Glasses",
      parts: [
        { layer: "face", anchor: { x: "eye", y: "eye" }, mirror: "sides", shapes: [circle(0, 0, 6, "stroke", "ink", { width: 2.1 })] },
        { layer: "face", anchor: { x: "face", y: "eye" }, units: "eyes", shapes: [path("M -0.55 -1 Q 0 -3.5 0.55 -1", "stroke", "ink", { width: 2.1 })] },
      ],
    },
    {
      id: "shades",
      name: "Shades",
      parts: [
        {
          layer: "face",
          anchor: { x: "eye", y: "eye" },
          mirror: "sides",
          shapes: [
            path("M -6.5 -1 Q -6.5 -4.5 -3 -4.5 H 3 Q 6.5 -4.5 6.5 -1 V 1.3 Q 6.5 4.8 3 4.8 H -3 Q -6.5 4.8 -6.5 1.3 Z", "fill", "ink"),
            path("M -3 -1.2 L -0.3 -2.7", "stroke", "shine", { width: 1.2 }),
          ],
        },
        { layer: "face", anchor: { x: "face", y: "eye" }, units: "eyes", shapes: [path("M -0.45 -1 H 0.45", "stroke", "ink", { width: 2 })] },
      ],
    },
    {
      id: "scarf",
      name: "Scarf",
      parts: [
        {
          layer: "neck",
          anchor: { x: "center", y: "neck", edgePad: 1 },
          units: "span",
          shapes: [
            path("M 0.35 5 L 0.55 18 L 0.2 18 Z", "inked", "accentShade"),
            path("M -1 -3 Q 0 3 1 -3 L 1 4 Q 0 10 -1 4 Z", "inked", "accent"),
          ],
        },
      ],
    },
    {
      id: "bowtie",
      name: "Bow tie",
      parts: [
        { layer: "neck", anchor: { x: "center", y: "neck" }, mirror: "local", shapes: [path("M 0 0 L 8 -5 L 8 5 Z", "inked", "accent")] },
        { layer: "neck", anchor: { x: "center", y: "neck" }, shapes: [circle(0, 0, 2.4, "inked", "accentShade")] },
      ],
    },
  ],
};
