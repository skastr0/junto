// A region label drag moves the region and its held members through React
// Flow; the document learns the positions only when the drag ends. A structural
// rebuild remints positions from the document, so one landing mid-drag would
// snap every moved node back. Canvas queues rebuilds while this holds and
// flushes when it clears.

import { observable } from "@legendapp/state";

/** True from a region label's pointerdown until its positions are persisted. */
export const regionLabelDrag$ = observable(false);
