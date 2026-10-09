import { asCanvasName, type Node, type Wire } from "../../src/shared/model";
import { authoring } from "../../src/renderer/lib/authoring";
import { modelStore } from "../../src/renderer/lib/use-model";
import { state$ } from "../../src/renderer/lib/state";

/** Open typed rows with a main that accepts commands, including undo and redo. */
export const openModelCanvas = (name: string, nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire> = []): (() => Promise<void>) => {
  const runtime = globalThis as unknown as { window?: unknown };
  const previous = runtime.window;
  runtime.window = { setTimeout: globalThis.setTimeout, confirm: () => true, junto: { modelCommand: async () => ({ seq: 0 }) } };
  state$.canvasName.set(name);
  authoring.forget(name);
  const release = modelStore.adopt({ canvas: asCanvasName(name), seq: 0, nodes, wires });
  return async () => {
    await authoring.idle(); release(); authoring.forget(name);
    if (previous === undefined) delete runtime.window;
    else runtime.window = previous;
  };
};
