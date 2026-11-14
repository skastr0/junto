/**
 * The connection handles on a card's edges (`NodeShell`'s eight handles,
 * styles.css 1495-1548). A card shows its four source dots on hover or when
 * selected; while a connection is being drawn it also shows the four dashed
 * target dots. Hidden below mid, as the DOM hides them at far and overview.
 *
 * Positions match `engine/pick.ts`: a 9 unit dot, source 2 units outside the
 * border, target 3 units inside it, centred on each side.
 */

import { renderedNodeSize } from "@shared/node-geometry";
import type { CardFact, CardView, Quad } from "../contract";
import { TIER_BIT } from "../contract";
import { at, shape, tok } from "./refs";

const HANDLE_TIERS = TIER_BIT.near | TIER_BIT.mid;
const DIAMETER = 9;
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
): Quad =>
  shape(
    { key, z, rect: at(x - DIAMETER / 2, y - DIAMETER / 2, DIAMETER, DIAMETER) },
    {
      fill: { kind: "flat", color: tok("ground") },
      stroke: {
        color: tok(color, 0.72),
        width: 1,
        ...(dashed ? { dash: [2, 2] as const } : {}),
      },
    },
    { tiers: HANDLE_TIERS, shape: "disc", band: "lifted" },
  );

/** The handles a hovered, selected or connecting card shows, in its own units. */
export const handleQuads = (fact: CardFact, view: CardView): Quad[] => {
  if (!view.hovered && !view.selected && !view.connecting) return [];
  const box = renderedNodeSize(fact.row.kind, fact.row);
  const quads: Quad[] = [];
  for (const side of SIDES) {
    const edge = edgeOf(side, box.width, box.height);
    if (view.connecting) {
      quads.push(dot(
        `handle.target.${side.name}`,
        edge.x + side.out.x * TARGET_OUT,
        edge.y + side.out.y * TARGET_OUT,
        "second",
        890,
        true,
      ));
    }
    quads.push(dot(
      `handle.source.${side.name}`,
      edge.x + side.out.x * SOURCE_OUT,
      edge.y + side.out.y * SOURCE_OUT,
      "main",
      900,
      false,
    ));
  }
  return quads;
};
