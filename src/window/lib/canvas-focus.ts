/**
 * The selection fact the GPU canvas is sent, as one source (SelectionFact in
 * canvas/contract.ts): the selected ids and wire, the connection-focus target,
 * the focus cone (`focusMode`) and the keyboard-focused card
 * (`focusedNodeId`). The cone is derived exactly as Canvas.tsx's
 * `selectionForCanvas` does — a connection focus paints its neighborhood,
 * else the selected node's stoppage cone — so the DOM canvas and the engine
 * dim the same cards for the same reason.
 *
 * Every store read is a tracked `.get()`, so the fact is correct inside a
 * Legend `observe` (feed/scene.ts) and when called imperatively (hands.ts).
 */
import { executionGraphContextFromActorRefs } from "@shared/graph";
import type { SelectionFact } from "../canvas/contract";
import { connectionFocusSelection, selectionImpact } from "./impact-mode";
import { kernel$ } from "./kernel-view";
import { canvasOfState } from "./model-store";
import { seatTasks$ } from "./seat-tasks";
import { state$ } from "./state";
import { modelStore } from "./use-model";

/**
 * The whole selection fact for `canvasName`. The focus cone belongs to the
 * open canvas only: a feed retained for another canvas gets the selection
 * fields without `focusMode`, as the DOM never cones a background canvas.
 */
export const canvasSelectionFact = (canvasName: string): SelectionFact => {
  const nodeIds = [...state$.selectedNodeIds.get()];
  const single = state$.selectedNodeId.get();
  const all = nodeIds.length === 0 && single !== "" ? [single] : nodeIds;
  const edgeId = state$.selectedEdgeId.get();
  const connectionFocus = state$.connectionFocusNodeId.get();
  const focused = state$.focusedNodeId.get();
  const fact: SelectionFact = {
    nodeIds: all,
    ...(edgeId === "" ? {} : { wireId: edgeId }),
    ...(connectionFocus === "" ? {} : { connectionFocusNodeId: connectionFocus }),
    ...(focused === "" ? {} : { focusedNodeId: focused }),
  };
  if (state$.canvasName.get() !== canvasName) return fact;

  // Tracked reads: the cone is rebuilt when the canvas's rows, the kernel's
  // execution or the selection's own fields move.
  const model = modelStore.canvas$(canvasName);
  model.seq.get();
  model.nodes.get();
  model.wires.get();
  const canvas = canvasOfState(canvasName, model.peek());

  const cone =
    connectionFocus !== ""
      ? { kind: "connection" as const, selection: connectionFocusSelection(canvas, connectionFocus) }
      : single !== ""
        ? {
            kind: "impact" as const,
            selection: selectionImpact(
              canvas,
              single,
              kernel$.execution.get(),
              executionGraphContextFromActorRefs(
                state$.canvasName.get(),
                state$.actorRefs.get(),
                seatTasks$.bySeat.get(),
              ),
            ),
          }
        : undefined;
  if (cone === undefined || !cone.selection.active) return fact;
  return {
    ...fact,
    focusMode: {
      kind: cone.kind,
      rootId: cone.selection.cone.rootId,
      memberIds: [...cone.selection.cone.nodeIds],
      leadIds: [...cone.selection.cone.attentionLeadIds],
      wireIds: [...cone.selection.cone.edgeIds],
    },
  };
};
