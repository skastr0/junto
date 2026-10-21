import { Option, Schema } from "effect";
import { ActorSeatId } from "./actor-seat";
import { OPERATOR_SEAT_ID, WorkNodeId, operatorActorRef, type ActorRef } from "./work-reference";

/**
 * Who wrote a mail, by kind (docs/machines.md, rule 4). Each kind has one
 * machine it may be written on: a seat's mail on the machine that seat lives
 * on, the operator's and an automation's on the machine that edits the canvas,
 * a resource's notice on the machine of the seat whose mailbox it is in.
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

/**
 * Stable non-executable identity a resource writes a notice under: a refusal
 * of a seat's command, told from the refused resource's node. Main writes it,
 * from the ruling, only into that seat's own mailbox; no caller names it.
 */
export const NOTICE_SEAT_ID = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"e".repeat(64)}`);

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
const decodeAutomationNodeId = Schema.decodeUnknownOption(AutomationNodeId);

/** The author of mail an automation sends: its own node, never the operator. */
export const automationActorRef = (canvasName: string, nodeId: AutomationNodeId): ActorRef => ({
  seatId: AUTOMATION_SEAT_ID,
  canvasName,
  nodeId,
});

/** The author of a notice from a resource node: never the operator, never a seat. */
export const noticeActorRef = (canvasName: string, nodeId: string): ActorRef => ({
  seatId: NOTICE_SEAT_ID,
  canvasName,
  nodeId,
});

export type MailAuthor =
  | { readonly kind: "seat"; readonly seatId: ActorSeatId; readonly nodeId: string }
  | { readonly kind: "operator" }
  | { readonly kind: "automation"; readonly nodeId: AutomationNodeId }
  /** A resource's notice into one seat's mailbox: `nodeId` is the resource, `mailbox` the seat's node. */
  | { readonly kind: "notice"; readonly nodeId: string; readonly mailbox: string }
  /** A fixed identity on a node that is not its own, or a notice outside a mailbox: no machine writes it. */
  | { readonly kind: "malformed" };

export type MailAuthorKind = MailAuthor["kind"];

/**
 * The author an actor reference names, read from its identity and node
 * together. `mailbox` is the node of the mailbox the row is in, for mail; a
 * notice anywhere else, or into its own node, is malformed.
 */
export const mailAuthorOf = (actor: Pick<ActorRef, "seatId" | "nodeId">, mailbox?: string): MailAuthor => {
  const operatorNode = actor.nodeId === OPERATOR_NODE_ID;
  if (actor.seatId === OPERATOR_SEAT_ID) return operatorNode ? { kind: "operator" } : { kind: "malformed" };
  if (operatorNode) return { kind: "malformed" };
  if (actor.seatId === NOTICE_SEAT_ID) {
    return mailbox !== undefined && mailbox !== actor.nodeId
      ? { kind: "notice", nodeId: actor.nodeId, mailbox }
      : { kind: "malformed" };
  }
  if (actor.seatId === AUTOMATION_SEAT_ID) {
    const nodeId = decodeAutomationNodeId(actor.nodeId);
    return Option.isSome(nodeId) ? { kind: "automation", nodeId: nodeId.value } : { kind: "malformed" };
  }
  return { kind: "seat", seatId: actor.seatId, nodeId: actor.nodeId };
};
