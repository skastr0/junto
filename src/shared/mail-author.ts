import { Schema } from "effect";
import { ActorSeatId } from "./actor-seat";
import { OPERATOR_SEAT_ID, WorkNodeId, operatorActorRef, type ActorRef } from "./work-reference";

/**
 * Who wrote a mail, by kind (docs/machines.md, rule 4). Each kind has one
 * machine it may be written on: a seat's mail on the machine that seat lives
 * on, the operator's and an automation's on the machine that edits the canvas.
 * The union is closed: a new kind fails `tsc` in every admission until that
 * admission says where the kind is written.
 *
 * Pure, no Node imports.
 */

/**
 * Stable non-executable identity an automation writes mail under. Like the
 * operator's, it is not an actor principal and never claims work; the
 * automation's own node says which automation wrote.
 */
export const AUTOMATION_SEAT_ID = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`);

const OPERATOR_NODE_ID = operatorActorRef("").nodeId;

/**
 * The node of an automation. Stand-in until canvas's `src/shared/automation.ts`
 * lands, which then owns it.
 */
export const AutomationNodeId = WorkNodeId.pipe(
  Schema.check(Schema.makeFilter((nodeId) => nodeId !== OPERATOR_NODE_ID || "the operator's node is no automation")),
  Schema.brand("AutomationNodeId"),
);
export type AutomationNodeId = typeof AutomationNodeId.Type;

/** The author of mail an automation sends: its own node, never the operator. */
export const automationActorRef = (canvasName: string, nodeId: AutomationNodeId): ActorRef => ({
  seatId: AUTOMATION_SEAT_ID,
  canvasName,
  nodeId,
});

export type MailAuthor =
  | { readonly kind: "seat"; readonly seatId: ActorSeatId; readonly nodeId: string }
  | { readonly kind: "operator" }
  | { readonly kind: "automation"; readonly nodeId: AutomationNodeId }
  /** The operator's or an automation's identity on a node that is not its own: no machine writes it. */
  | { readonly kind: "malformed" };

export type MailAuthorKind = MailAuthor["kind"];

/** The author an actor reference names, read from its identity and node together. */
export const mailAuthorOf = (actor: Pick<ActorRef, "seatId" | "nodeId">): MailAuthor => {
  const operatorNode = actor.nodeId === OPERATOR_NODE_ID;
  if (actor.seatId === OPERATOR_SEAT_ID) return operatorNode ? { kind: "operator" } : { kind: "malformed" };
  if (operatorNode) return { kind: "malformed" };
  if (actor.seatId === AUTOMATION_SEAT_ID) {
    return { kind: "automation", nodeId: actor.nodeId as AutomationNodeId };
  }
  return { kind: "seat", seatId: actor.seatId, nodeId: actor.nodeId };
};
