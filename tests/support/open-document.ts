import type { CanvasDoc } from "../../src/shared/canvas";
import { asCanvasName } from "../../src/shared/model";
import { inPaintOrder } from "../../src/shared/model/canvas";
import { canvasFromDocument, nodeToDocument, wireToDocument } from "../../src/shared/model/from-document";
import { followStore, showOpenedCanvas } from "../../src/renderer/lib/mutations";
import { state$ } from "../../src/renderer/lib/state";
import { modelStore } from "../../src/renderer/lib/use-model";

// A writer rig: fixtures written in the old document shape are read into the
// node store, which is what the window holds, and read back in that shape for
// the assertions that were written against it. Nothing in the window does
// either; this is for the tests alone.

// As in the app, what is selected follows the store for as long as the rig lives.
followStore();

let release: (() => void) | undefined;

/** Open a canvas in the node store from a document fixture, as if main had sent it. */
export const loadDoc = (doc: CanvasDoc, _revision?: string, name = state$.canvasName.peek() || "rig"): void => {
  release?.();
  if (state$.canvasName.peek() !== name) state$.canvasName.set(name);
  const canvas = canvasFromDocument(name, doc);
  release = modelStore.adopt({
    canvas: asCanvasName(name),
    seq: 0,
    nodes: [...canvas.nodes.values()],
    wires: [...canvas.wires.values()],
  });
  showOpenedCanvas(name);
};

/** A document fixture as the canvas would hold it and the rig read it back. */
export const heldShape = (doc: CanvasDoc, name = state$.canvasName.peek() || "rig"): CanvasDoc => {
  const canvas = canvasFromDocument(name, doc);
  return {
    nodes: inPaintOrder(canvas).map(nodeToDocument),
    edges: [...canvas.wires.values()].map(wireToDocument),
  };
};

/** What the open canvas holds, in the document shape the fixtures use. */
export const docNow = (): CanvasDoc => {
  const canvas = modelStore.canvasOf(state$.canvasName.peek());
  return {
    nodes: inPaintOrder(canvas).map(nodeToDocument),
    edges: [...canvas.wires.values()].map(wireToDocument),
  };
};
