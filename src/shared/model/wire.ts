import { Schema } from "effect";
import { Port } from "../physics/schema";
import { Verb, compileVerb, type VerbGrant } from "../physics/verbs";
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

/**
 * Node id to kind, for working out what wires grant. Build it once per pass:
 * a grant needs the kind at both ends of the wire.
 */
export const wireKinds = (
  nodes: Iterable<{ readonly id: string; readonly kind: string }>,
): ReadonlyMap<string, string> => {
  const kinds = new Map<string, string>();
  for (const node of nodes) if (!kinds.has(node.id)) kinds.set(node.id, node.kind);
  return kinds;
};

/**
 * What a wire grants. Nothing when an end is missing or the two kinds cannot
 * hold the verb; the mask only ever takes ports away.
 */
export const wireGrant = (
  wire: Pick<Wire, "from" | "to" | "verb" | "mask">,
  kinds: ReadonlyMap<string, string>,
): VerbGrant | undefined => {
  const grant = compileVerb(wire.verb, kinds.get(wire.from), kinds.get(wire.to));
  if (grant === undefined) return undefined;
  const mask = wire.mask;
  return mask === undefined
    ? grant
    : { ...grant, ports: grant.ports.filter((port) => mask.includes(port)) };
};
