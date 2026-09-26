/**
 * Wire traffic: one message actually typed into an agent seat.
 *
 * Main emits one event per delivered mail (and per operator answer to a
 * request) on `junto:wire-traffic`, and one `failed` event when typing a
 * message into a live seat did not land. It is a live, process-bound fact for
 * paint: the canvas pulses the wire from sender to receiver, and the
 * preamble surface names the sender. Nothing reads it back as durable
 * state; the mailbox receipt stays the delivery record.
 */

import type { Message } from "./canvas";
import { readMailExtension } from "./crew";
import { operatorActorRef } from "./work-reference";

/** What kind of interaction crossed the wire. */
export type WireTrafficKind = "notice" | "prompt" | "answer";

export type WireTrafficEvent = {
  readonly canvasName: string;
  /** The receiving seat's node. */
  readonly toNodeId: string;
  /** The sending seat's node; absent for operator and system mail. */
  readonly fromNodeId?: string;
  /** The sender's display name, when the mail carries one. */
  readonly fromName?: string;
  readonly kind: WireTrafficKind;
  readonly messageId: string;
  /** First line of the body, whitespace-collapsed, bounded. */
  readonly preview?: string;
  /** Epoch ms when the text reached the seat (or failed to). */
  readonly at: number;
  /**
   * The write into a live seat failed: nothing crossed the wire, and the
   * message waits in the mailbox for the seat's next ready moment. Told
   * once per message; never pulsed.
   */
  readonly failed?: true;
};

export const WIRE_TRAFFIC_PREVIEW_MAX = 80;

/** First non-empty line of a body, collapsed and cut to the preview bound. */
export const wireTrafficPreview = (text: string): string | undefined => {
  const line = text
    .split(/\r?\n/u)
    .map((candidate) => candidate.replace(/\s+/gu, " ").trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined) return undefined;
  if (line.length <= WIRE_TRAFFIC_PREVIEW_MAX) return line;
  return `${line.slice(0, WIRE_TRAFFIC_PREVIEW_MAX - 1).trimEnd()}…`;
};

const bodyText = (message: Message): string =>
  message.parts
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n");

/** The event for one mailbox message delivered into `toNodeId`'s seat. */
export const wireTrafficOfMail = (input: {
  readonly canvasName: string;
  readonly toNodeId: string;
  readonly message: Message;
  readonly at: number;
}): WireTrafficEvent => {
  const mail = readMailExtension(input.message.metadata);
  const sender = mail?.senderNodeId;
  // The operator is not a canvas node, so it is never a wire end.
  const operator = operatorActorRef(input.canvasName).nodeId;
  const preview = wireTrafficPreview(bodyText(input.message));
  return {
    canvasName: input.canvasName,
    toNodeId: input.toNodeId,
    ...(sender !== undefined && sender !== operator && sender !== input.toNodeId
      ? { fromNodeId: sender }
      : {}),
    ...(mail?.senderName !== undefined ? { fromName: mail.senderName } : {}),
    kind: mail?.mailKind === "prompt" ? "prompt" : "notice",
    messageId: input.message.messageId,
    ...(preview !== undefined ? { preview } : {}),
    at: input.at,
  };
};
