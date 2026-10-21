/**
 * Who wrote a post or opened a record. Operator is the Command Center human;
 * actor is a process-bound seat. Never Message.role and never client-supplied
 * freeform.
 */
import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";

export const AuthorKind = Schema.Literals(["operator", "actor"]);
export type AuthorKind = typeof AuthorKind.Type;

export const Author = Schema.Struct({
  kind: AuthorKind,
  /** Present when kind === "actor". */
  seatId: Schema.optionalKey(ActorSeatId),
  nodeId: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
});
export type Author = typeof Author.Type;
