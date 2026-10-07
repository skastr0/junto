import { observe } from "@legendapp/state";
import { asCanvasName } from "@shared/model";
import { nodeOfDocument, wireOfDocument } from "@shared/model/from-document";
import { state$ } from "./state";
import { modelStore } from "./use-model";

// Temporary. Until main serves `modelOpen` and `modelChanged`, the open
// canvas's nodes and wires are worked out here from the document the window
// already holds, so components can move onto the store one at a time. When the
// last of them has moved, main fills the store and this file is deleted.

const refused = new Set<string>();

/** A row the model refuses is left out, and said once. */
const kept = <Row>(id: string, row: Row | undefined): Row[] => {
  if (row !== undefined) return [row];
  if (!refused.has(id)) {
    refused.add(id);
    console.warn(`[model] ${id} is not a kind the model knows`);
  }
  return [];
};

/** Keep the store filled from the open document. Returns the stop function. */
export const followDocument = (): (() => void) => {
  let release: (() => void) | undefined;
  let held = "";
  const stop = observe(() => {
    const canvas = state$.canvasName.get();
    const doc = state$.doc.get();
    if (!canvas) {
      release?.();
      release = undefined;
      held = "";
      return;
    }
    const opened = {
      canvas: asCanvasName(canvas),
      seq: 0,
      // Each row is held by the node or edge object it came from
      // (from-document.ts), so only what a change touched is converted.
      nodes: doc.nodes.flatMap((node, z) => kept(node.id, nodeOfDocument(canvas, node, z))),
      wires: doc.edges.flatMap((edge) => kept(edge.id, wireOfDocument(edge))),
    };
    const previous = release;
    release = modelStore.adopt(opened);
    if (held === canvas) previous?.();
    else {
      previous?.();
      held = canvas;
    }
  });
  return () => {
    stop();
    release?.();
    release = undefined;
    held = "";
  };
};
