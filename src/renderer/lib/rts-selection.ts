import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode, CanvasEdge } from "@shared/canvas";
import { nodeToDocument, wireToDocument } from "@shared/model/from-document";
import { modelStore } from "./use-model";
import { state$ } from "./state";

/** Stable scalar subscriptions for command chrome, which does not show placement. */
export function useRtsValue<T>(read: () => T): T {
  const key = use$(() => JSON.stringify(read()));
  return useMemo(() => JSON.parse(key) as T, [key]);
}

export const useSelectedNodeIds = (): ReadonlyArray<string> =>
  useRtsValue(() => [...new Set(state$.selectedNodeIds.get())].sort());

export function rtsNode(canvas: string, id: string): CanvasNode | undefined {
  const node = modelStore.node$(canvas, id).get();
  if (!node) return undefined;
  return nodeToDocument(node);
}

/** Resolve complete current data at the gesture, never from a displayed snapshot. */
export function readRtsNode(canvas: string, id: string): CanvasNode | undefined {
  const node = modelStore.node$(canvas, id).peek();
  return node ? nodeToDocument(node) : undefined;
}

export function withCurrentRtsNode(id: string, action: (node: CanvasNode) => unknown): void {
  const node = readRtsNode(state$.canvasName.peek(), id);
  if (node) void action(node);
}

export function useRtsNodes(canvas: string, ids: ReadonlyArray<string>): ReadonlyArray<CanvasNode> {
  const key = use$(() => JSON.stringify(ids.flatMap(id => {
    const node = rtsNode(canvas, id);
    if (!node) return [];
    // Only the comparison omits placement. No fabricated node escapes it.
    const { x, y, width, height, ...displayed } = node;
    return [displayed];
  })));
  return useMemo(() => JSON.parse(key).flatMap(({ id }: { id: string }) => {
    const node = readRtsNode(canvas, id);
    return node ? [node] : [];
  }), [canvas, key]);
}

export const useRtsWire = (canvas: string, id: string): CanvasEdge | null =>
  useRtsValue(() => {
    const wire = modelStore.wire$(canvas, id).get();
    return wire ? wireToDocument(wire) : null;
  });
