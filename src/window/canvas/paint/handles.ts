/**
 * The connection handles on a card's edges (`NodeShell`'s eight handles,
 * styles.css 1495-1563). A card shows its four source dots on hover and while a
 * connection is drawn. The dashed target dot appears only on the handle
 * being aimed at, never on every side, and never as a permanent overlay on a
 * selected card. Hidden below mid, as the DOM hides them at far and overview.
 *
 * Positions match `engine/pick.ts`: a 9 unit dot, source 2 units outside the
 * border, target 3 units inside it, centred on each side.
 *
 * A card the gesture would land on says so from across the canvas: the landing
 * dot wears the DOM's `connectingto.valid` paint (second colour, dashed, with
 * a lit room around it) and the card itself takes a second-colour frame, so
 * the operator sees both the side and the card accepting the wire even when
 * the target was found by the snap radius or by dropping on the body.
 */

import { RADIUS } from "@shared/theme";
import { renderedNodeSize } from "@shared/node-geometry";
import type { CardFact, CardView, ColorRef, Quad, Radii } from "../contract";
import { TIER_BIT } from "../contract";
import { KIND_SHELL_RADII, SEAT } from "./card-spec";
import { at, grow, shape, tok } from "./refs";

const HANDLE_TIERS = TIER_BIT.near | TIER_BIT.mid;
const DIAMETER = 9;
/** `box-shadow: 0 0 16px` around the landing dot, as one disc. */
const ROOM = DIAMETER + 10;
const SOURCE_OUT = 2;
const TARGET_OUT = -3;

type Side = { readonly name: "top" | "right" | "bottom" | "left"; readonly out: { readonly x: number; readonly y: number } };

const SIDES: ReadonlyArray<Side> = [
  { name: "top", out: { x: 0, y: -1 } },
  { name: "right", out: { x: 1, y: 0 } },
  { name: "bottom", out: { x: 0, y: 1 } },
  { name: "left", out: { x: -1, y: 0 } },
];

/** A card that takes a wire today (model-edits `wireable`, pick.ts). */
export const takesHandles = (fact: CardFact): boolean => {
  const kind = fact.row.kind;
  return kind !== "region" && kind !== "label" && kind !== "git" && kind !== "files";
};

/** The landing frame traces the card's own corners, two units out. */
const frameRadii = (fact: CardFact): Radii => {
  switch (fact.row.kind) {
    case "agent": return SEAT.radii;
    // A kind seat's shell is a pill beside an xl, and the shader clamps a
    // radius to half the short side, so the left end stays round.
    case "note": return Number.parseFloat(RADIUS.md ?? "6");
    case "peer":
    case "stub": return Number.parseFloat(RADIUS.pill ?? "999");
    default: return KIND_SHELL_RADII;
  }
};

const edgeOf = (
  side: Side,
  width: number,
  height: number,
): { readonly x: number; readonly y: number } => {
  switch (side.name) {
    case "top": return { x: width / 2, y: 0 };
    case "right": return { x: width, y: height / 2 };
    case "bottom": return { x: width / 2, y: height };
    case "left": return { x: 0, y: height / 2 };
  }
};

const dot = (
  key: string,
  x: number,
  y: number,
  color: "main" | "second",
  z: number,
  dashed: boolean,
  over?: { readonly fill?: ColorRef; readonly stroke?: ColorRef },
): Quad =>
  shape(
    { key, z, rect: at(x - DIAMETER / 2, y - DIAMETER / 2, DIAMETER, DIAMETER) },
    {
      fill: { kind: "flat", color: over?.fill ?? tok("ground") },
      stroke: {
        color: over?.stroke ?? tok(color, 0.72),
        width: 1,
        ...(dashed ? { dash: [2, 2] as const } : {}),
      },
    },
    { tiers: HANDLE_TIERS, shape: "disc", band: "lifted" },
  );

/** The handles a hovered, selected or connecting card shows, in its own units. */
export const handleQuads = (fact: CardFact, view: CardView): Quad[] => {
  if (!view.hovered && !view.connecting) return [];
  const size = renderedNodeSize(fact.row.kind, fact.row);
  const box = at(0, 0, size.width, size.height);
  const quads: Quad[] = [];
  // The landing side is the one the gesture would take, not the one the
  // pointer hovers: a snap within CONNECT_SNAP_RADIUS lands without touching a
  // dot, and a drop on the card body lands on the side it came from nearest.
  const landing =
    view.connecting === true && view.connectTarget?.nodeId === fact.id && view.connectTarget.role === "target"
      ? view.connectTarget.side
      : undefined;
  if (landing !== undefined) {
    // The card's own frame in the second colour: which card is receiving.
    quads.push(shape(
      { key: "handle.target.frame", z: 870, rect: grow(box, 2) },
      { stroke: { color: tok("second", 0.55), width: 1 } },
      { tiers: HANDLE_TIERS, radii: frameRadii(fact), band: "lifted" },
    ));
  }
  // The DOM lights the one handle under the pointer (`:hover`), not all four.
  const hoveredSource = view.hoveredHandle?.role === "source" ? view.hoveredHandle.side : undefined;
  for (const side of SIDES) {
    const edge = edgeOf(side, size.width, size.height);
    if (side.name === landing) {
      const x = edge.x + side.out.x * TARGET_OUT;
      const y = edge.y + side.out.y * TARGET_OUT;
      quads.push(shape(
        { key: `handle.target.room.${side.name}`, z: 880, rect: at(x - ROOM / 2, y - ROOM / 2, ROOM, ROOM) },
        { fill: { kind: "flat", color: tok("second", 0.2) }, stroke: { color: tok("second", 0.5), width: 1 } },
        { tiers: HANDLE_TIERS, shape: "disc", band: "lifted" },
      ));
      quads.push(dot(
        `handle.target.${side.name}`,
        x,
        y,
        "second",
        890,
        true,
        { fill: tok("second", 0.25), stroke: tok("second", 0.95) },
      ));
    }
    quads.push(dot(
      `handle.source.${side.name}`,
      edge.x + side.out.x * SOURCE_OUT,
      edge.y + side.out.y * SOURCE_OUT,
      "main",
      900,
      false,
      side.name === hoveredSource ? { fill: tok("main", 0.35) } : undefined,
    ));
  }
  return quads;
};
