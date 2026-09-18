/**
 * SeatAwarenessHoverForNode — the advisory hover, bound to a live seat node.
 *
 * The hover is a leaf that takes the canonical status and an assessment. This
 * binds it to a node: it resolves the binding, reads the two stores, derives
 * the canonical status through the same `seatCardStatus` the card body uses,
 * and renders the hover.
 *
 * It exists because the hover cannot live inside the card body: the node shell
 * clips its children, so a hover mounted there is in the DOM with a real box
 * and is painted away. It renders into the shell's overlay slot instead.
 */

import type { ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { useNodeAttentionReasons } from "../../lib/occupancy-feed";
import { agentSeat$, seatNeedsLook } from "../../lib/agent-seat-state";
import { seatCardStatus } from "../../lib/seat-card-status";
import { seatAwareness$ } from "../../lib/seat-awareness";
import { terminal$ } from "../../lib/terminal-state";
import { SeatAwarenessHover } from "./SeatAwarenessHover";

export function SeatAwarenessHoverForNode({
  node,
  graphBlocked = false,
  className,
}: {
  readonly node: CanvasNode;
  readonly graphBlocked?: boolean;
  readonly className?: string | undefined;
}): ReactNode {
  const bindingId = node.ether?.terminal?.bindingId ?? "";
  const seatEvent = use$(agentSeat$.byBindingId[bindingId]);
  const session = use$(terminal$.sessionByBindingId[bindingId]);
  const awarenessAssessment = use$(seatAwareness$.byBindingId[bindingId]);
  const attentionReasons = useNodeAttentionReasons(node);
  const status = seatCardStatus({
    node,
    seatEvent,
    needsLook: seatNeedsLook(bindingId),
    session,
    graphBlocked,
    attentionReasons,
  });
  if (status === undefined) return null;
  return (
    <SeatAwarenessHover
      bindingId={status.bindingId}
      control={{
        state: status.presentation ?? status.seatState,
        label: status.activity.label,
        tone: status.activity.tone,
        pulse: status.activity.mode === "pulse",
        detail: status.subtitle,
      }}
      assessment={awarenessAssessment}
      className={className}
    />
  );
}
