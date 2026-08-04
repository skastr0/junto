import { parseHerdrSurfaceId } from "../../lib/dock-state";
import { dock$ } from "../../lib/dock-state";
import { getHerdrTerminal } from "../../lib/herdr-state";
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
    const nodeId = parseHerdrSurfaceId(surface.id);
    if (nodeId) {
      const terminal = getHerdrTerminal(nodeId);
      if (terminal) return terminal.title || "herdr";
      return `herdr - ${nodeId.slice(0, 12)}`;
    }
    return "herdr";
  }
  if (surface.kind === "terminal") {
    const nodeId = parseTerminalSurfaceId(surface.id);
    const node = nodeId ? terminal$.openByNodeId[nodeId].peek() : undefined;
    return node?.type === "text" ? node.text : "terminal";
  }
  if (surface.kind === "chat") {
    return dock$.chatById[surface.id].peek()?.title ?? "ACP chat";
  }
  if (surface.kind === "task-create") {
    const payload = dock$.taskCreateById[surface.id].peek();
    if (!payload) return "enqueue";
    return payload.mode === "proposal" ? `propose - ${payload.title}` : `enqueue - ${payload.title}`;
  }
  return surface.kind;
}

/** herdr surface id → nodeId. Canonical form is `herdr:${nodeId}` only. */
export function parseHerdrNodeId(surfaceId: string): string | undefined {
  return parseHerdrSurfaceId(surfaceId) ?? undefined;
}
