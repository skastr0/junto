/**
 * Open the live work surface for a canvas node — same authority as card
 * double-click / command-group re-tap onto an actor.
 *
 * Kind dispatch is closed to openable surfaces only. Notes, regions, gauges,
 * and other furniture return false (caller still focuses/selects).
 */
import type { CanvasNode } from "@shared/canvas";
import { HERDR_ENABLED } from "@shared/features";
import { ACP_CHAT_SURFACE_HIDDEN } from "@shared/legacy-surfaces";
import { resolveTerminalBinding } from "@shared/terminal";
import { openAgentChatSurface } from "./dock-state";
import { openHerdrTerminal } from "./herdr-state";
import { openTerminal } from "./terminal-actions";
import { openWorkDetail } from "./work-detail-open";

export type ActivateNodeSurfaceResult =
  | { readonly opened: true; readonly kind: string }
  | { readonly opened: false; readonly reason: "no-surface" | "unavailable" };

/**
 * Pure classification: which surface would open for this node (if any).
 * Side-effect free — used by tests and UI affordance gates.
 */
export function nodeSurfaceKind(
  node: CanvasNode,
): "terminal" | "herdr" | "chat" | "work" | null {
  const kind = node.ether?.entity?.kind;
  if (kind === "herdr") return HERDR_ENABLED ? "herdr" : null;
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
    kind === "pad"
  ) {
    return "work";
  }
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
    case "herdr": {
      const binding = node.ether?.herdr;
      if (!binding) return { opened: false, reason: "unavailable" };
      const title =
        (node.type === "text" ? node.text : "").split("\n")[0] || "herdr";
      openHerdrTerminal(node.id, binding, title);
      return { opened: true, kind: "herdr" };
    }
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
  }
}
