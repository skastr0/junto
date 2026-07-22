import { parseHerdrSurfaceId } from "../../lib/dock-state";
import { dock$ } from "../../lib/dock-state";
import { getHerdrTerminal, herdr$ } from "../../lib/herdr-state";
import type { WorkbenchState, WorkSurface } from "../../lib/surface-registry";
import { parseTerminalSurfaceId } from "../../lib/dock-state";
import { terminal$ } from "../../lib/terminal-state";

/** Short tab/header label for a surface. */
export function surfaceLabel(
  surface: WorkSurface,
  _registry: WorkbenchState = dock$.registry.peek(),
): string {
  void _registry;
  if (surface.kind === "browser") {
    const payload = dock$.browserByRef[surface.id].peek();
    return payload?.title ?? payload?.url ?? surface.id.slice(0, 24);
  }
  if (surface.kind === "herdr") {
    const nodeId = parseHerdrSurfaceId(surface.id) ?? parseHerdrNodeIdLegacy(surface.id);
    if (nodeId) {
      const terminal = getHerdrTerminal(nodeId);
      if (terminal) return terminal.title || "herdr";
      return `herdr · ${nodeId.slice(0, 12)}`;
    }
    return "herdr";
  }
  if (surface.kind === "terminal") {
    const nodeId = parseTerminalSurfaceId(surface.id);
    const node = nodeId ? terminal$.openByNodeId[nodeId].peek() : undefined;
    return node?.type === "text" ? node.text : "terminal";
  }
  return surface.kind;
}

/**
 * Defensive herdr surface id → nodeId.
 * Prefers `herdr:${nodeId}`; falls back to legacy `herdr-terminal` → focused.
 */
export function parseHerdrNodeId(surfaceId: string): string | undefined {
  const parsed = parseHerdrSurfaceId(surfaceId);
  if (parsed) return parsed;
  return parseHerdrNodeIdLegacy(surfaceId);
}

function parseHerdrNodeIdLegacy(surfaceId: string): string | undefined {
  if (surfaceId === "herdr-terminal" || surfaceId === "herdr") {
    return herdr$.focusedNodeId.peek() ?? undefined;
  }
  return undefined;
}
