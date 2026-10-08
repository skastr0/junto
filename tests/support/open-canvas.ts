import { asCanvasName, type Node, type Wire } from "../../src/shared/model";
import type { Canvas } from "../../src/shared/model/canvas";
import { followStore, showOpenedCanvas } from "../../src/renderer/lib/mutations";
import { state$ } from "../../src/renderer/lib/state";
import { modelStore } from "../../src/renderer/lib/use-model";

// A writer rig: the canvas is put in the node store as main would have sent
// it, and the window is told it has just opened, with no main to read from.

// As in the app, what is selected follows the store for as long as the rig lives.
followStore();

let release: (() => void) | undefined;

/** Open a canvas in the node store from model rows, and make it the open one. */
export const openCanvas = (
  name: string,
  nodes: ReadonlyArray<Node>,
  wires: ReadonlyArray<Wire> = [],
): void => {
  release?.();
  if (state$.canvasName.peek() !== name) state$.canvasName.set(name);
  release = modelStore.adopt({ canvas: asCanvasName(name), seq: 0, nodes, wires });
  showOpenedCanvas(name);
};

/** The open canvas as the store holds it now. */
export const held = (): Canvas => modelStore.canvasOf(state$.canvasName.peek());

/** One node of the open canvas, by id. */
export const nodeHeld = (id: string): Node | undefined => held().nodes.get(id as Node["id"]);
