/**
 * Threads, wired: the view state to the operator threads store, the canvas's
 * seats to the urgent order, and the one thread chat to the right pane.
 * OperatorModalHost mounts it only while open, so the store's watches live
 * exactly as long as the modal.
 */
import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { nodesOf } from "@shared/model";
import { loadMoreOperatorThreads, useOperatorThreads } from "../../lib/operator-threads";
import { state$ } from "../../lib/state";
import { threadsStoreView, threadsView$, urgentSeatsFirst } from "../../lib/threads-view";
import { useCanvas } from "../../lib/use-model";
import { seatUrgencyOf } from "../SeatRing";
import { ThreadsBody } from "./ThreadsModal";

export function OperatorThreads() {
  const canvasName = use$(state$.canvasName);
  const canvas = useCanvas(canvasName);
  const region = use$(threadsView$.region);
  const order = use$(threadsView$.order);
  const query = use$(threadsView$.query);
  const unread = use$(threadsView$.unread);
  const seat = use$(threadsView$.seat);
  // Read once each time Most urgent first is picked (and on open), so the
  // order holds still while the operator moves through it.
  const urgentFirst = useMemo(
    () => (order === "urgency" ? urgentSeatsFirst(nodesOf(canvas, "agent"), seatUrgencyOf) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [order, canvasName],
  );
  const view = threadsStoreView({ region, query, unread, seat, order }, canvasName, urgentFirst);
  const read = useOperatorThreads(view);
  // Every thread on the canvas, for "5 of 24": the same list as the view when nothing narrows it.
  const all = useOperatorThreads({ canvasName });
  return (
    <ThreadsBody
      canvasName={canvasName}
      read={read}
      all={{ total: all.total, unread: all.unread }}
      nodesById={canvas.nodes}
      onLoadMore={() => void loadMoreOperatorThreads(view)}
      // The one thread chat takes this pane when SeatThreads exports it (product-modals).
      chat={() => null}
    />
  );
}
