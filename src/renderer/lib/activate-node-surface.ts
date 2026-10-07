/**
 * Open the live work surface for a canvas node — same authority as card
 * double-click / command-group re-tap onto an actor.
 *
 * Kind dispatch is closed to openable surfaces only. Notes, regions, gauges,
 * and other furniture return false (caller still focuses/selects).
 */
import type { Node } from "@shared/model";
import { nodeToDocument } from "@shared/model/from-document";
import { BROWSER_ENABLED, productNodeKindEnabled } from "@shared/features";
import { formatNodeRef } from "@shared/node-ref";
import { browser$ } from "./browser-state";
import { nodeAt } from "./use-model";
import {
  openDockBrowser,
  openNoteSurface,
} from "./dock-state";
import { hostOf } from "./presentation";
import { state$ } from "./state";
import { openTerminal } from "./terminal-actions";
import { openWorkDetail } from "./work-detail-open";

export type ActivateNodeSurfaceResult =
  | { readonly opened: true; readonly kind: string }
  | { readonly opened: false; readonly reason: "no-surface" | "unavailable" };

export type NodeSurfaceKind =
  | "terminal"
  | "work"
  | "note"
  | "page";

/**
 * Pure classification: which surface would open for this node (if any).
 * Side-effect free — used by tests and UI affordance gates.
 */
export function nodeSurfaceKind(node: Node): NodeSurfaceKind | null {
  if (node.kind === "terminal" || node.kind === "agent") return "terminal";
  if (productNodeKindEnabled(node.kind) &&
    (node.kind === "task" || node.kind === "requests" || node.kind === "artifacts" ||
     node.kind === "board" || node.kind === "pad" || node.kind === "sheet" || node.kind === "git")) return "work";
  if (BROWSER_ENABLED && node.kind === "page") return "page";
  if (node.kind === "note") return "note";
  return null;
}

/**
 * Focus is the caller's job (hotkeys already call focusNode). This only opens
 * the model / work surface when one exists for the node.
 */
export function activateNodeSurface(nodeId: string): ActivateNodeSurfaceResult {
  const node = nodeAt(state$.canvasName.peek(), nodeId);
  if (!node) return { opened: false, reason: "no-surface" };
  const surface = nodeSurfaceKind(node);
  if (surface === null) {
    return { opened: false, reason: "no-surface" };
  }

  switch (surface) {
    case "terminal": {
      // canvas-nodes owns this last inner boundary until openTerminal takes a native node.
      void openTerminal(nodeToDocument(node));
      return { opened: true, kind: "terminal" };
    }
    case "work": {
      openWorkDetail(node.id);
      return { opened: true, kind: "work" };
    }
    case "note": {
      // The note workbench still takes the document form at this inner boundary.
      openNoteSurface(nodeToDocument(node));
      return { opened: true, kind: "note" };
    }
    case "page": {
      const canvasName = state$.canvasName.peek();
      if (node.kind !== "page") return { opened: false, reason: "no-surface" };
      const browser = { profile: node.profile, host: node.host, onRemove: node.onRemove };
      const url = node.url;
      if (!canvasName) return { opened: false, reason: "unavailable" };
      let pageRef: string;
      try {
        pageRef = formatNodeRef({ canvasName, nodeId: node.id });
      } catch {
        return { opened: false, reason: "unavailable" };
      }
      const session = browser$.sessionByRef[pageRef].peek();
      void openDockBrowser(pageRef, {
        nodeId: node.id,
        browser,
        url,
        title: session?.title ?? hostOf(url),
      });
      return { opened: true, kind: "page" };
    }
  }
}

/**
 * Open the surface of the one selected node: the keyboard's way to do what a
 * double-click on the card does. Nothing opens for an empty or multiple
 * selection.
 */
export function activateSelectedNodeSurface(): ActivateNodeSurfaceResult {
  const id = state$.selectedNodeId.peek();
  return id ? activateNodeSurface(id) : { opened: false, reason: "no-surface" };
}
