/**
 * The cone the open canvas is painting: the connection focus first, else the
 * selected card's stoppage cone, else nothing.
 *
 * One source for both canvases and for the chip that names the cone. It reads
 * the stores imperatively (`peek`), so a caller inside a tracked `observe`
 * gets the fact it asked for without this module deciding when it changes.
 */
import { executionGraphContextFromActorRefs } from "@shared/graph";
import {
  connectionFocusSelection,
  selectionImpact,
  type ImpactSelection,
} from "./impact-mode";
import { kernel$ } from "./kernel-view";
import { seatTasks$ } from "./seat-tasks";
import { state$ } from "./state";
import { modelStore } from "./use-model";

export type ConeContext = ReturnType<typeof currentExecutionGraphContext>;

export const currentExecutionGraphContext = () =>
  executionGraphContextFromActorRefs(
    state$.canvasName.peek(),
    state$.actorRefs.peek(),
    seatTasks$.bySeat.peek(),
  );

export const selectionForCanvas = (
  selectedNodeId: string,
  context: ConeContext,
): ImpactSelection => {
  const connectionFocusNodeId = state$.connectionFocusNodeId.peek();
  const canvas = modelStore.canvasOf(context.canvasName);
  if (connectionFocusNodeId) {
    return connectionFocusSelection(canvas, connectionFocusNodeId);
  }
  return selectedNodeId
    ? selectionImpact(canvas, selectedNodeId, kernel$.execution.peek(), context)
    : selectionImpact(canvas, "", null, context);
};
