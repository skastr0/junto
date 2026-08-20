import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { TaskClaim } from "@shared/work-model";
import { state$ } from "../../../lib/state";
import { stationLine } from "./station-map";
import { pruneToLine, strandedPins } from "./station-pins";
import { TaskMetroMap } from "./TaskMetroMap";

/**
 * Creation-side metro map bound to the canvas. A sink with no flow
 * destinations has no line to draw, so the plain quick-create path stays
 * exactly as it was — the map only appears where the work will actually travel.
 */
export function TaskCreationMetroMap({
  nodeId,
  pins,
  onPinsChange,
}: {
  /** Sink the task is being raised at — the origin of the line. */
  readonly nodeId: string;
  readonly pins?: ReadonlyArray<TaskClaim>;
  /** Absent leaves the map read-only. */
  readonly onPinsChange?: (next: ReadonlyArray<TaskClaim>) => void;
}) {
  const doc = use$(state$.doc);
  const line = useMemo(() => stationLine(doc, nodeId), [doc, nodeId]);

  // The flow graph can change under an open composer. A pin addressed to a
  // station that left the line can never be answered, so it is dropped rather
  // than carried into the task.
  useEffect(() => {
    if (!onPinsChange || pins === undefined) return;
    if (strandedPins(pins, line).length === 0) return;
    onPinsChange(pruneToLine(pins, line));
  }, [line, onPinsChange, pins]);

  if (line.length < 2) return null;

  return (
    <TaskMetroMap
      line={line}
      {...(pins !== undefined ? { pins } : {})}
      {...(onPinsChange ? { onPinsChange } : {})}
    />
  );
}
