import { batch, observable, observe } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { state$ } from "./state";

// The open document's nodes by id, for the few card bodies that have not
// moved onto the node store and still take a document node. One subscriber to
// the document publishes each node under its own key, and only when that node
// changed, so a body hears its own node and no other. Goes with the last of
// those bodies.

const byId$ = observable<Record<string, CanvasNode | undefined>>({});

let stop: (() => void) | undefined;

const start = (): void => {
  if (stop !== undefined) return;
  stop = observe(() => {
    const nodes = state$.doc.nodes.get();
    const held = byId$.peek();
    const live = new Set<string>();
    batch(() => {
      for (const node of nodes) {
        live.add(node.id);
        if (held[node.id] !== node) byId$[node.id].set(node);
      }
      for (const id of Object.keys(held)) if (!live.has(id)) byId$[id].delete();
    });
  });
};

/** The document's node with this id, or nothing while the document does not hold it. */
export const useDocumentNode = (id: string): CanvasNode | undefined => {
  start();
  return use$(byId$[id]);
};

/** The same, read once and not followed. */
export const documentNodeAt = (id: string): CanvasNode | undefined => {
  start();
  return byId$[id].peek();
};
