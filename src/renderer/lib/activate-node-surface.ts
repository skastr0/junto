/**
 * Open the live work surface for a canvas node — same authority as card
 * double-click / command-group re-tap onto an actor.
 *
 * Kind dispatch is closed to openable surfaces only. Notes, regions, gauges,
 * and other furniture return false (caller still focuses/selects).
 */
import type { CanvasNode } from "@shared/canvas";
import { BROWSER_ENABLED } from "@shared/features";
import { ACP_CHAT_SURFACE_HIDDEN } from "@shared/legacy-surfaces";
import { formatNodeRef } from "@shared/node-ref";
import { resolveTerminalBinding } from "@shared/terminal";
import { browser$ } from "./browser-state";
import {
  openAgentChatSurface,
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
  | "chat"
  | "work"
  | "note"
  | "page";

/**
 * Pure classification: which surface would open for this node (if any).
 * Side-effect free — used by tests and UI affordance gates.
 */
export function nodeSurfaceKind(node: CanvasNode): NodeSurfaceKind | null {
  const kind = node.ether?.entity?.kind;
  if (kind === "terminal" || kind === "agent") {
    if (resolveTerminalBinding(node)?.kind === "native") return "terminal";
    if (kind === "agent" && !ACP_CHAT_SURFACE_HIDDEN) return "chat";
    return null;
  }
  if (
    kind === "task" ||
    kind === "requests" ||
    kind === "artifacts" ||
    kind === "board" ||
    kind === "pad" ||
    kind === "sheet" ||
    kind === "git"
  ) {
    return "work";
  }
  if (
    BROWSER_ENABLED &&
    node.type === "link" &&
    kind === "page" &&
    Boolean(node.ether?.browser)
  ) {
    return "page";
  }
  if (node.type === "text" && !node.ether?.entity) return "note";
  return null;
}

/**
 * Focus is the caller's job (hotkeys already call focusNode). This only opens
 * the model / work surface when one exists for the node.
 */
export function activateNodeSurface(node: CanvasNode): ActivateNodeSurfaceResult {
  const surface = nodeSurfaceKind(node);
  if (surface === null) {
    return { opened: false, reason: "no-surface" };
  }

  switch (surface) {
    case "terminal": {
      void openTerminal(node);
      return { opened: true, kind: "terminal" };
    }
    case "chat": {
      openAgentChatSurface(node);
      return { opened: true, kind: "chat" };
    }
    case "work": {
      openWorkDetail(node.id);
      return { opened: true, kind: "work" };
    }
    case "note": {
      openNoteSurface(node);
      return { opened: true, kind: "note" };
    }
    case "page": {
      const canvasName = state$.canvasName.peek();
      const browser = node.ether?.browser;
      const url = node.type === "link" ? node.url : "";
      if (!canvasName || !browser) return { opened: false, reason: "unavailable" };
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
