import { observe } from "@legendapp/state";
import type { CanvasEdge, CanvasNode } from "@shared/canvas";
import { asCanvasName, type Node, type Wire } from "@shared/model";
import { nodeFromDocument, wireFromDocument } from "@shared/model/from-document";
import { state$ } from "./state";
import { modelStore } from "./use-model";

// Temporary. Until main serves `modelOpen` and `modelChanged`, the open
// canvas's nodes and wires are worked out here from the document the window
// already holds, so components can move onto the store one at a time. When the
// last of them has moved, main fills the store and this file is deleted.

type Converted<T> = { readonly z: number; readonly row: T | undefined };

const nodes = new WeakMap<CanvasNode, Converted<Node>>();
const wires = new WeakMap<CanvasEdge, Converted<Wire>>();
const refused = new Set<string>();

const convert = <Source extends { readonly id: string }, Row>(
  cache: WeakMap<Source, Converted<Row>>,
  source: Source,
  z: number,
  make: () => Row,
): Row | undefined => {
  const known = cache.get(source);
  if (known !== undefined && known.z === z) return known.row;
  let row: Row | undefined;
  try {
    row = make();
  } catch (error) {
    // A row the model refuses is left out, and said once.
    if (!refused.has(source.id)) {
      refused.add(source.id);
      console.warn(`[model] ${source.id} is not a kind the model knows:`, error);
    }
  }
  cache.set(source, { z, row });
  return row;
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
      nodes: doc.nodes.flatMap((node, z) => {
        const row = convert(nodes, node, z, () => nodeFromDocument(canvas, node, z));
        return row === undefined ? [] : [row];
      }),
      wires: doc.edges.flatMap((edge) => {
        const row = convert(wires, edge, 0, () => wireFromDocument(canvas, edge));
        return row === undefined ? [] : [row];
      }),
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
