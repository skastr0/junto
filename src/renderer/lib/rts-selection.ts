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
  // Legacy field controls still consume this view; placement is read by an
  // opened editor, never by the always-mounted command chrome.
  return nodeToDocument({ ...node, x: 0, y: 0, width: 0, height: 0, z: 0 });
}

export const useRtsNodes = (canvas: string, ids: ReadonlyArray<string>): ReadonlyArray<CanvasNode> =>
  useRtsValue(() => ids.map(id => rtsNode(canvas, id)).filter((node): node is CanvasNode => node !== undefined));

export const useRtsWire = (canvas: string, id: string): CanvasEdge | null =>
  useRtsValue(() => {
    const wire = modelStore.wire$(canvas, id).get();
    return wire ? wireToDocument(wire) : null;
  });
