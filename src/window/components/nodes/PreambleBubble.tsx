import { useLayoutEffect, type RefObject } from "react";
import { use$ } from "@legendapp/state/react";
import { useStore } from "@xyflow/react";
import type { SeatBubble } from "../../lib/preamble-feed";
import { dismissPreamble } from "../../lib/preamble-state";
import { stopNodeGestureUnlessMultiSelect } from "../../lib/multi-select-gesture";
import { state$ } from "../../lib/state";
import { cameraSettled$ } from "../../lib/canvas-tier";
import { PreambleBubbleView } from "./PreambleBubbleView";

export { PreambleBubbleView } from "./PreambleBubbleView";

/** NodeToolbar's offset above the node, and the air left between it and the bubble. */
const TOOLBAR_OFFSET = 8;
const TOOLBAR_AIR = 6;

/**
 * Lifts a lone selected seat's bubble just over its toolbar. The toolbar is
 * drawn at screen size while the bubble scales with the canvas, so the lift
 * is the toolbar's measured height turned into canvas units at this zoom.
 * Mounted only while lifted, so a resting seat never follows the zoom.
 */
function ToolbarLift({ target, nodeId }: { readonly target: RefObject<HTMLDivElement | null>; readonly nodeId: string }) {
  const zoom = useStore((store) => store.transform[2]);
  useLayoutEffect(() => {
    const el = target.current;
    if (!el) return;
    const bar = document.querySelector(`.react-flow__node-toolbar[data-id="${CSS.escape(nodeId)}"]`);
    const height = bar?.getBoundingClientRect().height ?? 42;
    el.style.setProperty("--pre-lift", `${String((TOOLBAR_OFFSET + height + TOOLBAR_AIR) / zoom)}px`);
    return () => {
      el.style.removeProperty("--pre-lift");
    };
  }, [target, nodeId, zoom]);
  return null;
}

/** The live bubble: lifted over a lone selection's toolbar, placed again when the camera rests. */
export function PreambleBubble({
  nodeId,
  bubble,
  selected,
  tail = "ring",
}: {
  readonly nodeId: string;
  readonly bubble: SeatBubble;
  readonly selected: boolean;
  readonly tail?: "ring" | "right";
}) {
  // The floating toolbar shows only for a lone selected node (NodeShell); a
  // region, a shift set or a rubber band leaves the seat bare, so the bubble
  // stays on its ring.
  const lifted = use$(() => selected && state$.selectedNodeIds.get().length <= 1);
  // A slide measured against the old view is wrong in the new one: it lays
  // the bubble over a neighbour's. Measured again each time the camera rests.
  const settled = use$(cameraSettled$);
  return (
    <PreambleBubbleView
      nodeId={nodeId}
      bubble={bubble}
      tail={tail}
      lifted={lifted}
      settled={settled}
      lift={(target) => <ToolbarLift target={target} nodeId={nodeId} />}
      onDismiss={(preambleId) => dismissPreamble(nodeId, preambleId)}
      onClosePointerDown={(event) => stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })}
    />
  );
}
