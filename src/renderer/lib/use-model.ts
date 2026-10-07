import { use$ } from "@legendapp/state/react";
import { useEffect } from "react";
import type { Node, NodeKind, NodeOf, Wire } from "@shared/model";
import type { Canvas } from "@shared/model/canvas";
import { titleOf } from "@shared/model/title";
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

/** One node as it stands now, read once and not followed. */
export const nodeAt = (canvas: string, id: string): Node | undefined => modelStore.node$(canvas, id).peek();

/** What a node is called now, or its id when the store does not hold it. */
export const titleAt = (canvas: string, id: string): string => {
  const node = nodeAt(canvas, id);
  return node === undefined ? id : titleOf(node);
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

/**
 * One thing read off one node of a known kind. Undefined when the node is
 * absent or of another kind. `read` should return a plain value, so the
 * caller hears that field and nothing else.
 */
export const useNodeFieldOf = <K extends NodeKind, T>(
  canvas: string,
  id: string,
  kind: K,
  read: (node: NodeOf<K>) => T,
): T | undefined =>
  useNodeValue(canvas, id, (node) => (node?.kind === kind ? read(node as NodeOf<K>) : undefined));

/** Node ids in paint order. Changes when a node is added, removed or restacked. */
export const useNodeIds = (canvas: string): ReadonlyArray<string> =>
  use$(modelStore.canvas$(canvas).nodeIds);

/** A whole canvas, followed: its nodes and wires as the store has them now. */
export const useCanvas = (canvas: string): Canvas =>
  use$(() => {
    const open$ = modelStore.canvas$(canvas);
    open$.nodes.get();
    open$.wires.get();
    return modelStore.canvasOf(canvas);
  });

export const useWire = (canvas: string, id: string): Wire | undefined =>
  use$(modelStore.wire$(canvas, id));

/** Wire ids. Changes when a wire is added or removed. */
export const useWireIds = (canvas: string): ReadonlyArray<string> =>
  use$(modelStore.canvas$(canvas).wireIds);
