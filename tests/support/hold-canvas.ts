import { asCanvasName, type Node } from "../../src/shared/model";
import { modelStore } from "../../src/renderer/lib/use-model";

/** Hold typed model rows directly, without a document conversion. */
export const holdModelCanvas = (canvas: string, nodes: ReadonlyArray<Node>): (() => void) =>
  modelStore.adopt({ canvas: asCanvasName(canvas), seq: 0, nodes, wires: [] });
