import { Schema } from "effect";
import { CANONICAL_CANVAS_NAME_PATTERN } from "../canvas-name";
import { NodeId } from "../physics/schema";
import { HostId } from "../remote-hosts";

// What every thing on a canvas has in common: its own id and where it sits.
// Nothing else is shared. Which canvas it is on is said once, by whatever
// carries it (a command, an event, a table row), never repeated on the node.
// Whatever a kind knows beyond this is a named field on that kind (see
// kinds.ts), so there is no place to put a field that belongs to no kind.

/** The name of a canvas. A thing's identity is always canvas name plus id. */
export const CanvasName = Schema.String.pipe(
  Schema.check(Schema.isPattern(CANONICAL_CANVAS_NAME_PATTERN)),
  Schema.brand("CanvasName"),
);
export type CanvasName = typeof CanvasName.Type;

/** Trusted canvas name (already canonical) without parse overhead. */
export const asCanvasName = (name: string): CanvasName => name as CanvasName;

export { NodeId, asNodeId } from "../physics/schema";
export { HostId } from "../remote-hosts";

/** A preset number ("1" to "6") or a hex colour, as the palette writes it. */
export const Color = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
);
export type Color = typeof Color.Type;

export const Side = Schema.Literals(["top", "right", "bottom", "left"]);
export type Side = typeof Side.Type;

const Length = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)));

/**
 * Where a thing sits and how it stacks. `z` is the paint order within its
 * canvas, lowest first. Only the order matters, so it may be any integer and
 * need not be dense: bringing one node to the front changes that node alone.
 */
export const placement = {
  id: NodeId,
  x: Schema.Finite,
  y: Schema.Finite,
  width: Length,
  height: Length,
  z: Schema.Int,
  color: Schema.optionalKey(Color),
} as const;

export const Placement = Schema.Struct(placement);
export type Placement = typeof Placement.Type;

/** The rectangle alone, for moves, resizes and hit tests. */
export const Frame = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Length,
  height: Length,
});
export type Frame = typeof Frame.Type;
