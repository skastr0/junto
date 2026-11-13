/**
 * The canvas's context menus, as state (docs/canvas-gpu-architecture.md,
 * section 16). The pointer machine says which menu a right click asks for;
 * this holds it, the shell draws it, and every action goes to the writers the
 * menus use today. No React Flow and no DOM lookup: a pointer menu is placed
 * at the screen point it happened at, a marquee's menu beside the box.
 */

import { observable } from "@legendapp/state";
import type { NodeId, Point } from "../contract";
import { canvasApi } from "./canvas-api";
import { state$ } from "../../lib/state";
import type { ScreenRect } from "../../lib/menu-placement";
import type { MenuIntent } from "./hands";

export type CanvasMenuState =
  | { readonly kind: "pane"; readonly at: Point; readonly screen: Point; readonly nodeId?: NodeId }
  | { readonly kind: "seat"; readonly nodeId: NodeId; readonly screen: Point }
  | { readonly kind: "target"; readonly targetId: NodeId; readonly sourceIds: ReadonlyArray<NodeId>; readonly screen: Point }
  | {
      readonly kind: "selection";
      readonly nodeIds: ReadonlyArray<NodeId>;
      readonly screen: Point;
      /** Set for a marquee: the box on screen the menu opens beside. */
      readonly anchor?: ScreenRect;
    };

export const canvasMenu$ = observable<CanvasMenuState | null>(null);

export const closeCanvasMenu = (): void => {
  canvasMenu$.set(null);
};

const selected = (): ReadonlyArray<NodeId> => {
  const multi = state$.selectedNodeIds.peek();
  const single = state$.selectedNodeId.peek();
  if (multi.length > 0) return multi;
  return single === "" ? [] : [single];
};

/** Open the menu an intent asked for. A wire has no menu today (inventory, section 7). */
export const openCanvasMenu = (intent: MenuIntent): void => {
  switch (intent.kind) {
    case "menu":
      switch (intent.target) {
        case "pane":
          canvasMenu$.set({
            kind: "pane",
            at: intent.at,
            screen: intent.screen,
            ...(intent.nodeId === undefined ? {} : { nodeId: intent.nodeId }),
          });
          return;
        case "card":
          if (intent.nodeId !== undefined) canvasMenu$.set({ kind: "seat", nodeId: intent.nodeId, screen: intent.screen });
          return;
        case "selection":
          canvasMenu$.set({ kind: "selection", nodeIds: selected(), screen: intent.screen });
          return;
        case "wire":
          return;
      }
      return;
    case "connectMenu":
      canvasMenu$.set({
        kind: "target",
        targetId: intent.targetId,
        sourceIds: intent.sourceIds,
        screen: intent.screen,
      });
      return;
    case "marqueeMenu": {
      const api = canvasApi();
      const corner = api?.boardToScreen({ x: intent.bounds.x, y: intent.bounds.y }) ?? intent.bounds;
      const zoom = api?.camera().zoom ?? 1;
      canvasMenu$.set({
        kind: "selection",
        nodeIds: intent.nodeIds,
        screen: { x: corner.x, y: corner.y },
        anchor: {
          left: corner.x,
          top: corner.y,
          right: corner.x + intent.bounds.width * zoom,
          bottom: corner.y + intent.bounds.height * zoom,
        },
      });
      return;
    }
  }
};
