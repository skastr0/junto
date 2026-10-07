import type { CanvasDoc, CanvasEdge, CanvasNode } from "@shared/canvas";
import type { Node, Wire } from "@shared/model";
import type { Canvas } from "@shared/model/canvas";
import { nodeToDocument, wireToDocument } from "@shared/model/from-document";

// TEMPORARY. The window's document, worked out from the node store.
//
// The window no longer reads a document from main. The readers that still take
// a document node get one from here: the store's rows in the old shape. It is
// deleted with the last of those readers, and with it `state$.doc`. Nothing
// new may read the document; a new reader takes its node from the store
// (use-model.ts).
//
// A document node is made once for a row and kept for as long as the row is
// the same object, so a change to one node gives every other reader the node
// it already had, and the document itself is the same object when nothing in
// it changed.

/** Rows in paint order, lowest first: by `z`, then by id. */
const inPaintOrder = (nodes: Iterable<Node>): Node[] =>
  [...nodes].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export type DocumentProjection = (canvas: Canvas) => CanvasDoc;

/** One projection per canvas shown: it remembers what it made for each row. */
export const createDocumentProjection = (): DocumentProjection => {
  let nodesMade = new Map<string, { readonly row: Node; readonly node: CanvasNode }>();
  let wiresMade = new Map<string, { readonly row: Wire; readonly edge: CanvasEdge }>();
  let last: CanvasDoc | undefined;

  return (canvas) => {
    const nextNodes = new Map<string, { readonly row: Node; readonly node: CanvasNode }>();
    const nodes = inPaintOrder(canvas.nodes.values()).map((row) => {
      const made = nodesMade.get(row.id);
      const kept = made !== undefined && made.row === row ? made : { row, node: nodeToDocument(row) };
      nextNodes.set(row.id, kept);
      return kept.node;
    });
    const nextWires = new Map<string, { readonly row: Wire; readonly edge: CanvasEdge }>();
    const edges = [...canvas.wires.values()].map((row) => {
      const made = wiresMade.get(row.id);
      const kept = made !== undefined && made.row === row ? made : { row, edge: wireToDocument(row) };
      nextWires.set(row.id, kept);
      return kept.edge;
    });
    nodesMade = nextNodes;
    wiresMade = nextWires;
    const same =
      last !== undefined &&
      last.nodes.length === nodes.length &&
      last.edges.length === edges.length &&
      nodes.every((node, index) => node === last!.nodes[index]) &&
      edges.every((edge, index) => edge === last!.edges[index]);
    if (!same) last = { nodes, edges };
    return last!;
  };
};
