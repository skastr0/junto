/**
 * Seat rollups for the open canvas as a plain read — the same derivation
 * `useSeatRollups` answers inside React, for the feed and the GPU canvas.
 * Call inside `observe` to follow every input, or once for a snapshot.
 */
import type { SeatRollup } from "../../lib/seat-rollup";
import { seatRollupsForCanvas } from "../../lib/minimap-seat-colors";
import { seatSignalRollups$ } from "../../lib/agent-signals-state";
import { modelStore } from "../../lib/use-model";
import { state$ } from "../../lib/state";
import { healthClockNow } from "../../lib/thread-health";

export const readSeatRollups = (canvasName: string): ReadonlyMap<string, SeatRollup> =>
  seatRollupsForCanvas(modelStore.canvasOf(canvasName), {
    now: healthClockNow(),
    severityByNodeId: state$.regionSeverityByNodeId.get(),
    signalsByNodeId:
      canvasName === state$.canvasName.peek() ? seatSignalRollups$.peek() : {},
  });
