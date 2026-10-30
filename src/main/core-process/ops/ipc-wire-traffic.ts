/**
 * The canvas's wire traffic (junto/ipc.ts): a message typed into a seat
 * pulses its wire, and a continuation line held by a seat's input box is said
 * on the seat as held mail is. Both sources live in the core (the delivery
 * path and the injection supervisor), so the notices are told from here and
 * main broadcasts them to the window on the channel it listens to.
 */
import { wireTrafficPreview, type WireTrafficEvent } from "@shared/wire-traffic";
import { injectionSupervisor } from "../../junto/term/injection-supervisor";
import { messageDelivery } from "../../junto/work/message-delivery";
import { termPlane } from "../../junto/term/plane";
import { WIRE_TRAFFIC } from "../channels";
import { publish } from "../push";

// A continuation line held by the seat's input box, said on the seat.
injectionSupervisor.subscribeContinuationHeld((bindingId, hold, line) => {
  const live = termPlane.host.get(bindingId);
  if (!live?.canvasName || !live.nodeId) return;
  publish(
    WIRE_TRAFFIC,
    {
      canvasName: live.canvasName,
      toNodeId: live.nodeId,
      kind: "notice",
      messageId: `continuation:${bindingId}:${live.epoch}`,
      preview: wireTrafficPreview(line),
      at: Date.now(),
      held: hold,
    } satisfies WireTrafficEvent,
  );
});

// Every message typed into a seat pulses its wire on the canvas.
messageDelivery.subscribeDelivered((event) => publish(WIRE_TRAFFIC, event));
