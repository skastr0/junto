import type { Canvas } from "@shared/model/canvas";
import type { SeatTaskIndex } from "@shared/execution-graph";

// What the kernel holds of one canvas: what is on it and how it is joined,
// and beside it the open task each seat holds (`readSeatTaskIndex`). A
// canvas holds no work.

export type World = {
  readonly canvas: Canvas;
  readonly seatTasks: SeatTaskIndex;
};
