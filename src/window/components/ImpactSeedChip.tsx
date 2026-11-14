/**
 * The impact or focus chip, top-left of the field: the stoppage cone the
 * selection paints, or the neighborhood of the inspected card while a
 * connection focus is on. It names the seed the canvas is dimming around.
 *
 * It is DOM above whichever canvas draws, not part of one: the same stores
 * feed it, so it mounts beside the canvas (or inside the old canvas's tree)
 * and reads the same cone. Isolated in its own component so selection and
 * execution ticks re-render the chip alone.
 */
import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { selectionForCanvas } from "../lib/canvas-impact";
import { kernel$ } from "../lib/kernel-view";
import { seatTasks$ } from "../lib/seat-tasks";
import { state$ } from "../lib/state";
import { useCanvas } from "../lib/use-model";

export function ImpactSeedChip() {
  const selectedNodeId = use$(state$.selectedNodeId);
  const connectionFocusNodeId = use$(state$.connectionFocusNodeId);
  const executionRev = use$(kernel$.executionRev);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);
  const canvas = useCanvas(canvasName);
  const heldBy = use$(seatTasks$.bySeat);
  const impact = useMemo(() => {
    const context = executionGraphContextFromActorRefs(canvasName, actorRefs, heldBy);
    return selectionForCanvas(selectedNodeId, context);
  }, [actorRefs, canvasName, connectionFocusNodeId, selectedNodeId, canvas, executionRev, heldBy]);
  if (!impact.active) return null;
  return (
    <div className="impact-hud-anchor">
      <div
        className="impact-hud"
        role="status"
        aria-live="polite"
        title={connectionFocusNodeId ? "Focused node connections" : "Stoppage impact cone for selection"}
      >
        <span className="impact-hud__mark" aria-hidden />
        <span className="impact-hud__eyebrow">{connectionFocusNodeId ? "focus" : "impact"}</span>
        <span className="impact-hud__label">{impact.seedLabel}</span>
      </div>
    </div>
  );
}
