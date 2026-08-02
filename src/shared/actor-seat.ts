import { Schema } from "effect";

/**
 * Stable compiled identity of one executable actor principal.
 *
 * The compiler derives this lowercase SHA-256 from the installation identity
 * and canonical actor binding identity. Canvas-local node IDs never substitute
 * for it.
 */
export const ActorSeatId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^seat_[a-f0-9]{64}$/)),
  Schema.brand("ActorSeatId"),
);
export type ActorSeatId = typeof ActorSeatId.Type;
