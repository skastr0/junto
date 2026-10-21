/**
 * Who a resource actor's mail is from (plan 0.10, 03 and 07): the stamp its
 * rows carry and the author the repository admits them under. One answer for
 * every writer of an actor's mail, comments and ruling notices alike.
 *
 * - A seat writes as itself, on its own machine.
 * - The operator writes operator mail.
 * - An automation writes as its own node under AUTOMATION_SEAT_ID, never as
 *   the operator (mail-author.ts), on the machine that edits the canvas.
 */
import { Option, Schema } from "effect";
import type { MailSenderStamp } from "@shared/crew";
import { AutomationNodeId, automationActorRef } from "@shared/mail-author";
import { automationSenderStamp } from "@shared/mail-sender";
import type { Canvas } from "@shared/model";
import { asNodeId, mailSenderRegions } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { ResourceActor } from "@shared/resource-command";
import { OPERATOR_SEAT_ID, operatorActorRef, type ActorRef } from "@shared/work-reference";

export type ActorMail = { readonly stamp: MailSenderStamp; readonly sentBy: ActorRef };

const decodeAutomationNode = Schema.decodeUnknownOption(AutomationNodeId);

/** An actor's mail author, or undefined for an automation whose node is no automation's (the operator's). */
export const actorMailOf = (canvas: Canvas, canvasName: string, actor: ResourceActor): ActorMail | undefined => {
  switch (actor.kind) {
    case "seat": {
      const node = canvas.nodes.get(asNodeId(actor.nodeId));
      return {
        stamp: {
          fromSeat: actor.seatId,
          senderNodeId: actor.nodeId,
          senderName: node === undefined ? actor.nodeId : titleOf(node),
          senderRegions: mailSenderRegions(canvas, actor.nodeId),
          senderGeneration: "ruling",
          senderHarness: node?.kind === "agent" ? (node.harness ?? "unknown") : "unknown",
        },
        sentBy: { seatId: actor.seatId, canvasName, nodeId: actor.nodeId },
      };
    }
    case "operator":
      return {
        stamp: {
          fromSeat: OPERATOR_SEAT_ID,
          senderNodeId: "operator",
          senderName: "operator",
          senderGeneration: "operator",
          senderHarness: "unknown",
        },
        sentBy: operatorActorRef(canvasName),
      };
    case "automation": {
      const nodeId = decodeAutomationNode(actor.nodeId);
      if (Option.isNone(nodeId)) return undefined;
      const node = canvas.nodes.get(asNodeId(actor.nodeId));
      return {
        stamp: automationSenderStamp(nodeId.value, node === undefined ? actor.nodeId : titleOf(node)),
        sentBy: automationActorRef(canvasName, nodeId.value),
      };
    }
  }
};
