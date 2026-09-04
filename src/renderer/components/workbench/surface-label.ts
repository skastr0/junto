import { dock$ } from "../../lib/dock-state";
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
    return payload?.title ?? payload?.url ?? "page";
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
    return `enqueue - ${payload.title}`;
  }
  if (surface.kind === "note") {
    return dock$.noteById[surface.id].peek()?.title ?? "Note";
  }
  return surface.kind;
}
