import { use$ } from "@legendapp/state/react";
import { useEffect } from "react";
import type { Node, NodeKind, NodeOf, Wire } from "@shared/model";
import { getJuntoApi } from "./junto-api";
import { createModelStore, type ModelCanvasStatus } from "./model-store";

export const modelStore = createModelStore(getJuntoApi);

/** Keep a canvas open for as long as the caller is mounted. */
export const useOpenCanvas = (canvas: string): ModelCanvasStatus => {
  useEffect(() => {
    if (!canvas) return;
    return modelStore.open(canvas);
  }, [canvas]);
  return use$(() => (canvas ? modelStore.canvas$(canvas).status.get() : "closed"));
};

/** One node. The caller hears changes to this node and no other. */
export const useNode = (canvas: string, id: string): Node | undefined =>
  use$(modelStore.node$(canvas, id));

/** One node, when it is of the kind asked for. */
export const useNodeOf = <K extends NodeKind>(canvas: string, id: string, kind: K): NodeOf<K> | undefined => {
  const node = useNode(canvas, id);
  return node?.kind === kind ? (node as NodeOf<K>) : undefined;
};

/**
 * One thing read off one node. The caller re-renders only when what `read`
 * returns changes, so a card that shows a name does not hear a move.
 */
export const useNodeValue = <T>(canvas: string, id: string, read: (node: Node | undefined) => T): T =>
  use$(() => read(modelStore.node$(canvas, id).get()));

/** Node ids in paint order. Changes when a node is added, removed or restacked. */
export const useNodeIds = (canvas: string): ReadonlyArray<string> =>
  use$(modelStore.canvas$(canvas).nodeIds);

export const useWire = (canvas: string, id: string): Wire | undefined =>
  use$(modelStore.wire$(canvas, id));

/** Wire ids. Changes when a wire is added or removed. */
export const useWireIds = (canvas: string): ReadonlyArray<string> =>
  use$(modelStore.canvas$(canvas).wireIds);
