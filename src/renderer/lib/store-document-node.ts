import type { CanvasNode } from "@shared/canvas";
import { nodeToDocument } from "@shared/model/from-document";
import { nodeAt } from "./use-model";

/**
 * A node as the store has it now, in the document form that a helper not yet
 * moved to the model still takes. A step, not a place to stay: it goes when
 * the last such helper takes the node itself.
 */
export const storeNodeAsDocument = (canvas: string, id: string): CanvasNode | undefined => {
  const node = nodeAt(canvas, id);
  return node === undefined ? undefined : nodeToDocument(node);
};
