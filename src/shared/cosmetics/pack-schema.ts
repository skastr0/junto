import { Schema } from "effect";
import { COSMETIC_COORD_MAX, COSMETIC_PATH_MAX, parseCosmeticPath } from "./path";

// Cosmetic packs: DATA ONLY. A pack describes species (body outlines),
// toppers, accessories, patterns, and palettes as anchored shape data with
// metadata. Nothing in a pack executes: paths go through one closed grammar
// (./path.ts), colors are palette roles resolved from the theme tokens, and
// every number is bounded. The built-in base cast is a pack in this format
// (./base-pack.ts); premium packs arrive at build time through the overlay.

export const COSMETIC_PACK_FORMAT = 1;

const Id = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/)));
const Name = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(40)),
  Schema.check(Schema.isPattern(/^[^\u0000-\u001f\u007f<>&"]+$/)),
);
const between = (minimum: number, maximum: number) =>
  Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum, maximum })));
const Coord = between(-COSMETIC_COORD_MAX, COSMETIC_COORD_MAX);
const Length = between(0, 60);

/** A path in the one closed grammar; parsed again when drawn. */
const PathData = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(COSMETIC_PATH_MAX)),
  Schema.check(
    Schema.makeFilter((value: string) => parseCosmeticPath(value) !== undefined, {
      message: "path must use absolute M L H V Q C Z with plain numbers inside the local box",
    }),
  ),
);

/** Colors a pack may use: roles the renderer derives from the theme tokens. */
export const PALETTE_ROLES = [
  "body",
  "shade",
  "belly",
  "accent",
  "accentShade",
  "spark",
  "shine",
  "leaf",
  "wood",
  "blush",
  "drop",
  "mute",
  "ink",
] as const;
export const PaletteRole = Schema.Literals(PALETTE_ROLES);
export type PaletteRole = typeof PaletteRole.Type;

/**
 * inked: riso fill nudged off an ink outline (the house look).
 * fill:  flat fill, no outline.
 * line:  a colored stroke with an ink edge (antlers, straps).
 * stroke: a plain stroke (ink by default), no fill.
 * Widths are authored at card size and scale with the detail tier.
 */
export const Paint = Schema.Literals(["inked", "fill", "line", "stroke"]);
export type Paint = typeof Paint.Type;

const ShapeStyle = {
  paint: Paint,
  color: Schema.optionalKey(PaletteRole),
  width: Schema.optionalKey(between(0.3, 12)),
  opacity: Schema.optionalKey(between(0.05, 1)),
};

export const CosmeticShape = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("path"), d: PathData, ...ShapeStyle }),
  Schema.Struct({ kind: Schema.Literal("circle"), cx: Coord, cy: Coord, r: Length, ...ShapeStyle }),
  Schema.Struct({ kind: Schema.Literal("ellipse"), cx: Coord, cy: Coord, rx: Length, ry: Length, ...ShapeStyle }),
]);
export type CosmeticShape = typeof CosmeticShape.Type;

/**
 * Where a part's local origin lands on the critter.
 * x: center (body axis), face (face center), eye (an eye), ear (the ear
 *    spread), edge (the body outline at a height).
 * y: top (crown), eye, mouth, neck, center (body center), bottom.
 * `edgeAt` measures the edge at top + edgeAt (default: at the anchor's y);
 * `edgeScale`/`edgePad` scale and pad it. dx/dy shift the origin.
 */
export const CosmeticAnchor = Schema.Struct({
  x: Schema.Literals(["center", "face", "eye", "ear", "edge"]),
  y: Schema.Literals(["top", "eye", "mouth", "neck", "center", "bottom"]),
  dx: Schema.optionalKey(Coord),
  dy: Schema.optionalKey(Coord),
  edgeAt: Schema.optionalKey(Coord),
  edgeScale: Schema.optionalKey(between(0, 3)),
  edgePad: Schema.optionalKey(between(-30, 30)),
});
export type CosmeticAnchor = typeof CosmeticAnchor.Type;

/** Draw order around the critter. `body` is clipped to the silhouette. */
export const CosmeticLayer = Schema.Literals(["behind", "body", "front", "neck", "face", "hat"]);
export type CosmeticLayer = typeof CosmeticLayer.Type;

/**
 * units: px (default); body (x by body width, y by body height); bodyX (x by
 * body width); span (x by the measured edge); eyes (x by the eye gap).
 * mirror: sides draws the part on both sides of the body (the anchor flips
 * too); local mirrors it about its own origin; absent draws it once, on the
 * `side` given (right by default).
 */
export const CosmeticPart = Schema.Struct({
  layer: CosmeticLayer,
  anchor: CosmeticAnchor,
  units: Schema.optionalKey(Schema.Literals(["px", "body", "bodyX", "span", "eyes"])),
  mirror: Schema.optionalKey(Schema.Literals(["sides", "local"])),
  side: Schema.optionalKey(Schema.Literals(["left", "right"])),
  rotate: Schema.optionalKey(between(-180, 180)),
  pivot: Schema.optionalKey(Schema.Tuple([Coord, Coord])),
  shapes: Schema.Array(CosmeticShape).pipe(Schema.check(Schema.isMaxLength(32))),
  /** Smallest detail tier that draws this part (freckles skip glyph size). */
  minDetail: Schema.optionalKey(Schema.Literals(["card", "rich"])),
});
export type CosmeticPart = typeof CosmeticPart.Type;

const Parts = Schema.Array(CosmeticPart).pipe(Schema.check(Schema.isMaxLength(16)));
const Tier = Schema.Literals(["base", "premium"]);

/** Closed outline deformations over the superellipse body. */
export const BodyDeform = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pinchTop"), amount: between(0, 0.9), power: between(1, 4) }),
  Schema.Struct({ kind: Schema.Literal("pear"), amount: between(-0.4, 0.4) }),
  Schema.Struct({ kind: Schema.Literal("scallopTop"), lobes: between(1, 8), depth: between(0, 0.2) }),
  Schema.Struct({ kind: Schema.Literal("flattenBase"), exponent: between(0.2, 1) }),
  Schema.Struct({ kind: Schema.Literal("taper"), amount: between(0, 0.8), scale: between(0.8, 1.3) }),
  Schema.Struct({ kind: Schema.Literal("hem"), from: between(0, 1), waves: between(2, 16), depth: between(0, 0.12) }),
  Schema.Struct({ kind: Schema.Literal("cleft"), depth: between(0, 0.3), width: between(0.05, 0.5) }),
]);
export type BodyDeform = typeof BodyDeform.Type;

export const CosmeticSpecies = Schema.Struct({
  id: Id,
  name: Name,
  tier: Schema.optionalKey(Tier),
  body: Schema.Struct({
    n: between(1.2, 6),
    w: between(18, 42),
    h: between(22, 46),
    cy: between(50, 76),
    steps: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 12, maximum: 96 })))),
    deform: Schema.optionalKey(Schema.Array(BodyDeform).pipe(Schema.check(Schema.isMaxLength(4)))),
  }),
  parts: Schema.optionalKey(Parts),
  /** A species with its own headwear (a cap) hides toppers and hats. */
  coversToppers: Schema.optionalKey(Schema.Boolean),
  coversHats: Schema.optionalKey(Schema.Boolean),
  /** Floats instead of standing in the bare frame (no feet). */
  floats: Schema.optionalKey(Schema.Boolean),
});
export type CosmeticSpecies = typeof CosmeticSpecies.Type;

export const CosmeticTopper = Schema.Struct({
  id: Id,
  name: Name,
  tier: Schema.optionalKey(Tier),
  parts: Parts,
  /** Sits on the crown, so a hat covers it. */
  crown: Schema.optionalKey(Schema.Boolean),
});
export type CosmeticTopper = typeof CosmeticTopper.Type;

export const CosmeticAccessory = Schema.Struct({
  id: Id,
  name: Name,
  tier: Schema.optionalKey(Tier),
  parts: Parts,
  /** Headwear: covers crown toppers; a capped species hides it. */
  hat: Schema.optionalKey(Schema.Boolean),
});
export type CosmeticAccessory = typeof CosmeticAccessory.Type;

export const CosmeticPattern = Schema.Struct({
  id: Id,
  name: Name,
  tier: Schema.optionalKey(Tier),
  parts: Parts,
});
export type CosmeticPattern = typeof CosmeticPattern.Type;

/** Body palettes stay in the theme: a hue token, lightly adjusted. */
export const CosmeticPalette = Schema.Struct({
  id: Id,
  name: Name,
  tier: Schema.optionalKey(Tier),
  token: Schema.Literals(["amber", "orange", "gold", "green", "cyan", "violet", "indigo", "steel"]),
  lightness: Schema.optionalKey(between(-0.12, 0.12)),
  chroma: Schema.optionalKey(between(0.4, 1.6)),
});
export type CosmeticPalette = typeof CosmeticPalette.Type;

const Items = <S extends Schema.Top>(item: S) =>
  Schema.optionalKey(Schema.Array(item).pipe(Schema.check(Schema.isMaxLength(64))));

/** A catalog key: a bare id ("toast") or a namespaced one ("pack:item"). */
const Key = Schema.String.pipe(Schema.check(Schema.isPattern(/^(?:[a-z0-9][a-z0-9-]{0,31}:)?[a-z0-9][a-z0-9-]{0,31}$/)));
const DrawList = Schema.optionalKey(Schema.Array(Key).pipe(Schema.check(Schema.isMaxLength(64))));

/**
 * The seat-identity draw: the lists a seat's look is picked from, by catalog
 * key. The portrait engine keeps its own random rolls and draw order and
 * reads each list from the last installed pack that declares it (the base
 * pack declares them all). A drawn item this install may not wear falls back
 * to the base list with the same roll. `*More` lists belong to the second
 * cast: an independent stream that swaps a new species, ears, or pattern in
 * for some seats; `props` are the props a seat may be born wearing.
 */
export const IdentityTables = Schema.Struct({
  palettes: Schema.optionalKey(
    Schema.Array(
      Schema.Tuple([Key, Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 1, maximum: 16 })))]),
    ).pipe(Schema.check(Schema.isMaxLength(64))),
  ),
  species: DrawList,
  toppers: DrawList,
  patterns: DrawList,
  speciesMore: DrawList,
  toppersMore: DrawList,
  patternsMore: DrawList,
  props: DrawList,
});
export type IdentityTables = typeof IdentityTables.Type;

export const CosmeticPack = Schema.Struct({
  format: Schema.Literal(COSMETIC_PACK_FORMAT),
  id: Id,
  name: Name,
  tier: Tier,
  version: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9A-Za-z.+-]{1,32}$/)))),
  species: Items(CosmeticSpecies),
  toppers: Items(CosmeticTopper),
  accessories: Items(CosmeticAccessory),
  patterns: Items(CosmeticPattern),
  palettes: Items(CosmeticPalette),
  /**
   * `bare`: items keep their plain ids as catalog keys ("toast", not
   * "pack:toast"), so saved looks keep resolving when items move between the
   * base pack and a pack. A bare id may not collide with an installed one.
   */
  keys: Schema.optionalKey(Schema.Literal("bare")),
  identity: Schema.optionalKey(IdentityTables),
});
export type CosmeticPack = typeof CosmeticPack.Type;
