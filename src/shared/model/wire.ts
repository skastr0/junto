import { Schema } from "effect";
import { Port } from "../physics/schema";
import { Verb } from "../physics/verbs";
import { NodeId, Side } from "./base";

// A wire is the operator saying one thing may act on another, and how. What it
// grants is worked out from the verb and the kinds at its two ends; the wire
// stores only what the operator chose.

export const WireId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
  Schema.brand("WireId"),
);
export type WireId = typeof WireId.Type;

/** Trusted wire id without parse overhead. */
export const asWireId = (id: string): WireId => id as WireId;

export const Wire = Schema.Struct({
  id: WireId,
  /** The verb's subject: the end that acts. */
  from: NodeId,
  to: NodeId,
  verb: Verb,
  /** Ports the operator took away from what the verb grants. Never adds one. */
  mask: Schema.optionalKey(Schema.Array(Port)),
  /** Where the line attaches. Absent means the nearest side. */
  fromSide: Schema.optionalKey(Side),
  toSide: Schema.optionalKey(Side),
}).pipe(
  Schema.check(
    Schema.makeFilter((wire) => wire.from !== wire.to || "a wire joins two different nodes"),
  ),
);
export type Wire = typeof Wire.Type;

/** Read a wire from outside the process. An unknown field is an error. */
export const decodeWire = (input: unknown) =>
  Schema.decodeUnknownEffect(Wire)(input, { onExcessProperty: "error" });
