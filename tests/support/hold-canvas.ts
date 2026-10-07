import type { CanvasNode } from "../../src/shared/canvas";
import { asCanvasName, type Node } from "../../src/shared/model";
import { nodeOfDocument } from "../../src/shared/model/from-document";
import { modelStore } from "../../src/renderer/lib/use-model";

/**
 * Put nodes in the window's node store as an open canvas would hold them,
 * without a main to read them from. Returns the function that lets go.
 */
export const holdCanvas = (canvas: string, nodes: ReadonlyArray<CanvasNode>): (() => void) =>
  modelStore.adopt({
    canvas: asCanvasName(canvas),
    seq: 0,
    nodes: nodes.flatMap((node, z): Node[] => {
      const row = nodeOfDocument(canvas, node, z);
      return row === undefined ? [] : [row];
    }),
    wires: [],
  });
