/**
 * The list a far-zoom badge opens when the pointer rests on it: the seats it
 * stands for, one row each, a press on a row flies the camera to that seat.
 *
 * Each row is the canvas's own seat (AgentSeatView) fed by the same live
 * stores as its node, as the agent modal's rail draws its peers, so the list
 * and the canvas cannot disagree. The order is the urgency order at the
 * moment the list opened and holds still while it is open, so a row does not
 * move under the pointer. The list is a Popover, anchored to an invisible
 * element laid over the badge's drawn disc; when it opens and closes is
 * `cluster-hover.ts`.
 */
import { useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { asNodeId, type Seat } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { isMirrorablePeer } from "../../lib/actor-mirrors";
import { openOperatorModal } from "../../lib/operator-modal";
import { seatSaying } from "../../lib/seat-line";
import { useSeatOnboardingOf } from "../../lib/seat-onboarding";
import { seatUrgencyOrder } from "../../lib/urgency-order";
import { state$ } from "../../lib/state";
import { useCanvas } from "../../lib/use-model";
import { accentColor, INK } from "../../lib/theme";
import { AgentSeatView, SeatName } from "../../components/nodes/AgentSeat";
import { seatUrgencyOf, useSeatGlanceOf } from "../../components/SeatRing";
import { Popover } from "../../components/ui/Popover";
import "../../components/terminal/actor-rail.css";
import "./cluster-hover.css";
import { clusterHover$, clusterHoverPanel, type ClusterHoverState } from "./cluster-hover";

/** One seat of the badge: the canvas seat under a cover button that flies to it. */
function ClusterSeatRow({ seat }: { readonly seat: Seat }) {
  const glance = useSeatGlanceOf(seat);
  const onboarding = useSeatOnboardingOf(seat.bindingId);
  const name = titleOf(seat);
  const signal = glance.signal?.signal;
  const saying = seatSaying({ activity: glance.activity, signal, failure: glance.failure, health: glance.health });
  // An AI reading is named as one, as everywhere else: never the agent's own claim.
  const state = saying.kind === "signal" ? saying.word : saying.kind === "reading" ? `AI reads ${saying.text}` : saying.text;
  return (
    <li className="actor-rail__seat" data-testid="cluster-hover-seat" data-peer-node-id={seat.id}>
      <button
        type="button"
        className="actor-rail__go"
        aria-label={`Go to ${name}${state ? `, ${state}` : ""}`}
        title={`Go to ${name}`}
        data-testid="cluster-hover-go"
        onClick={() => {
          // Selects the seat and flies the camera to it, as every other jump to a seat does.
          state$.focusNodeId.set(seat.id);
          clusterHoverPanel.dismiss();
        }}
      />
      <AgentSeatView
        identity={seat.id}
        activity={glance.activity}
        title={<SeatName name={name} color={seat.color ? accentColor(seat.color) : INK} />}
        harness={glance.harness}
        context={glance.failure}
        health={glance.health}
        signal={{ worst: signal, openCount: glance.signal?.openCount ?? 0 }}
        onboarding={onboarding}
        onSignalOpen={() => openOperatorModal("feed")}
        overseer={seat.overseer}
        compact={false}
      />
    </li>
  );
}

function OpenList({ hover }: { readonly hover: ClusterHoverState }) {
  const canvas = useCanvas(use$(state$.canvasName));
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  // Held still while open: ordered once per opening, by the urgency each seat has then.
  const order = useMemo(() => {
    const seats = hover.memberIds
      .map((id) => canvas.nodes.get(asNodeId(id)))
      .filter((node): node is Seat => isMirrorablePeer(node));
    return seatUrgencyOrder(seats, seatUrgencyOf).map((seat) => seat.id);
    // The canvas changes as the board does; the order is for this opening only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover]);
  const seats = order.map((id) => canvas.nodes.get(asNodeId(id))).filter((node): node is Seat => isMirrorablePeer(node));
  const { x, y, width, height } = hover.rect;
  return (
    <>
      <div
        ref={setAnchor}
        aria-hidden
        data-testid="cluster-hover-anchor"
        style={{ position: "fixed", left: x, top: y, width, height, pointerEvents: "none" }}
      />
      {anchor !== null && seats.length > 0 ? (
        <Popover
          anchor={anchor}
          onClose={() => clusterHoverPanel.dismiss()}
          label={seats.length === 1 ? "Seat in this badge" : `${String(seats.length)} seats in this badge`}
          sides={["right", "left", "below", "above"]}
          align="center"
          width={248}
          className="cluster-hover-popover"
          testId="cluster-hover-list"
        >
          <div className="cluster-hover" onPointerEnter={clusterHoverPanel.enter} onPointerLeave={clusterHoverPanel.leave}>
            <ul className="actor-rail__seats">
              {seats.map((seat) => (
                <ClusterSeatRow key={seat.id} seat={seat} />
              ))}
            </ul>
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/** Mounted beside the canvas's card overlays: draws the list while a badge's hover holds one open. */
export function ClusterHoverList() {
  const hover = use$(clusterHover$);
  return hover === null ? null : <OpenList key={hover.key} hover={hover} />;
}
