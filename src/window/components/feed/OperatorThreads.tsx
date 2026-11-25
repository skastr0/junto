/**
 * Threads, wired: the view state to the operator threads store, the canvas's
 * seats to the urgent order, and the one thread chat to the right pane.
 * OperatorModalHost mounts it only while open, so the store's watches live
 * exactly as long as the modal.
 */
import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { nodesOf, titleOf } from "@shared/model";
import { feedRegionForCanvas } from "@shared/operator-feed";
import { closeOperatorModal } from "../../lib/operator-modal";
import { loadMoreOperatorThreads, useOperatorThreads } from "../../lib/operator-threads";
import { openSeatOn } from "../../lib/seat-view";
import { state$ } from "../../lib/state";
import { seatSummaryOf, threadsSeatOn, threadsStoreView, threadsView$, urgentSeatsFirst } from "../../lib/threads-view";
import { useCanvas } from "../../lib/use-model";
import { QuickThread } from "../quick-thread/QuickThread";
import { seatUrgencyOf } from "../SeatRing";
import { ThreadChat } from "../threads/SeatThreads";
import { ThreadsBody } from "./ThreadsModal";

export function OperatorThreads() {
  const canvasName = use$(state$.canvasName);
  const canvas = useCanvas(canvasName);
  const region = use$(threadsView$.region);
  const order = use$(threadsView$.order);
  const query = use$(threadsView$.query);
  const unread = use$(threadsView$.unread);
  const seat = threadsSeatOn(use$(threadsView$.seat), canvasName);
  // Read once each time Most urgent first is picked (and on open), so the
  // order holds still while the operator moves through it.
  const urgentFirst = useMemo(
    () => (order === "urgency" ? urgentSeatsFirst(nodesOf(canvas, "agent"), seatUrgencyOf) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [order, canvasName],
  );
  const view = threadsStoreView({ region, query, unread, seat, order }, canvasName, urgentFirst);
  const read = useOperatorThreads(view);
  // Every thread on the canvas, for "5 of 24". With nothing narrowing it is
  // the view's own list, so it is not held a second time: a second hold of the
  // same list without the urgent seats would read it newest first again.
  const narrowed = view.region !== undefined || view.search !== undefined || view.unread === true || view.seat !== undefined;
  const everything = useOperatorThreads({ canvasName }, narrowed);
  const all = narrowed ? everything : read;
  return (
    <ThreadsBody
      canvasName={canvasName}
      read={read}
      all={{ total: all.total, unread: all.unread }}
      nodesById={canvas.nodes}
      onLoadMore={() => void loadMoreOperatorThreads(view)}
      chat={(row, yields, picked) => (
        <ThreadChat
          seat={{ canvasName, seatId: row.seat.nodeId }}
          name={row.seat.name}
          thread={seatSummaryOf(row)}
          // Only a thread the operator chose is read on sight; the first of the list waits for an act in it.
          picked={picked}
          yields={yields}
        />
      )}
      quickThread={(done, backOut) => (
        <QuickThread
          canvasName={canvasName}
          onSent={(sent) => {
            const first = sent[0];
            if (first === undefined) return done(undefined);
            const node = canvas.nodes.get(first.seatId);
            done({
              ...first,
              ...(node === undefined
                ? {}
                : {
                    seat: { nodeId: node.id, name: titleOf(node), portraitIdentity: node.id },
                    region: feedRegionForCanvas(canvas, node.id),
                  }),
            });
          }}
          backOut={backOut}
        />
      )}
      // The seat modal on its Threads view, whatever Seat opens on says.
      onOpenSeat={(seatId) => {
        closeOperatorModal("threads");
        void openSeatOn(canvasName, seatId, "threads");
      }}
    />
  );
}
