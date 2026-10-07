/**
 * SeatAwarenessHoverForNode — the advisory hover, bound to a live seat node.
 *
 * The hover is a leaf that takes the canonical status and an assessment. This
 * binds it to a node by canvas and id: it reads the seat or terminal from the
 * node store one field at a time, reads the two live stores, derives
 * the canonical status through the same `seatCardStatus` the card body uses,
 * and renders the hover.
 *
 * It exists because the hover cannot live inside the card body: the node shell
 * clips its children, so a hover mounted there is in the DOM with a real box
 * and is painted away. It renders into the shell's overlay slot instead.
 */

import type { ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import type { Node } from "@shared/model";
import { useSeatAttentionReasons } from "../../lib/occupancy-feed";
import { agentSeat$, seatNeedsLook } from "../../lib/agent-seat-state";
import { seatCardStatus } from "../../lib/seat-card-status";
import { seatAwareness$ } from "../../lib/seat-awareness";
import { terminal$ } from "../../lib/terminal-state";
import { useNodeValue } from "../../lib/use-model";
import { SeatAwarenessHover } from "./SeatAwarenessHover";

/** A node that holds a terminal session: a seat or a plain terminal. */
const seated = (node: Node | undefined) =>
  node !== undefined && (node.kind === "agent" || node.kind === "terminal") ? node : undefined;

export function SeatAwarenessHoverForNode({
  canvas,
  id,
  graphBlocked = false,
  className,
}: {
  readonly canvas: string;
  readonly id: string;
  readonly graphBlocked?: boolean;
  readonly className?: string | undefined;
}): ReactNode {
  const bindingId = useNodeValue(canvas, id, (node) => seated(node)?.bindingId);
  const name = useNodeValue(canvas, id, (node) => (seated(node)?.label ?? "").split("\n")[0]?.trim() ?? "");
  const launch = useNodeValue(canvas, id, (node) => seated(node)?.launch);
  const harness = useNodeValue(canvas, id, (node) => (node?.kind === "agent" ? node.harness : undefined));
  const agentKey = useNodeValue(canvas, id, (node) => (node?.kind === "agent" ? node.agentKey : undefined));
  const seatEvent = use$(agentSeat$.byBindingId[bindingId ?? ""]);
  const session = use$(terminal$.sessionByBindingId[bindingId ?? ""]);
  const awarenessAssessment = use$(seatAwareness$.byBindingId[bindingId ?? ""]);
  const attentionReasons = useSeatAttentionReasons(agentKey);
  const status = seatCardStatus({
    face: bindingId === undefined ? undefined : { id, name, bindingId, harness, launch },
    seatEvent,
    needsLook: seatNeedsLook(bindingId ?? ""),
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
