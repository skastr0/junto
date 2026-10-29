import { Schema } from "effect";
import { ItemId, NodeId } from "./ids";

/**
 * Who a resource write is from, as the desktop and the phone read it (0.11.3,
 * the phone's artifacts): a seat, the operator, or an automation. A wire
 * module, so its import closure is `effect` alone; `actor-seat.ts` and
 * `resource-command.ts` re-export these, and the rules that judge a writer
 * (`writtenOn`) stay in `resource-command.ts`.
 */

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

/**
 * Who a command is from. A seat's command is written by the machine the seat
 * is on, an automation's by the machine it runs on, and the operator's only
 * by the editing machine (`writtenOn`, resource-command.ts). A command from
 * anywhere else is not refused: it closes the link, as a forged mail author does.
 */
export const ResourceActor = Schema.Union([
  /** The same author mail carries, so a command row is judged on the placement history mail is (`authorOf`, work-exchange.ts). */
  Schema.Struct({ kind: Schema.Literal("seat"), seatId: ActorSeatId, nodeId: NodeId }),
  Schema.Struct({ kind: Schema.Literal("operator") }),
  Schema.Struct({ kind: Schema.Literal("automation"), nodeId: NodeId, automationId: ItemId }),
]);
export type ResourceActor = typeof ResourceActor.Type;
