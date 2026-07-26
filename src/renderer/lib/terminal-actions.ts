/**
 * Terminal open / create / kill — used by the node toolbar and card double-click.
 * Session start is automatic on open; no Start button on the card body.
 */
import type { CanvasNode } from "@shared/canvas";
import { resolveTerminalBinding } from "@shared/terminal";
import { getVellumApi } from "./vellum-api";
import { state$ } from "./state";
import type { WorkZone } from "./surface-registry";
import { openTerminalSurface, terminal$ } from "./terminal-state";

export const ensureTerminalRunning = async (
  node: CanvasNode,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native") {
    return { ok: false, message: "unbound terminal" };
  }
  const api = getVellumApi();
  if (!api?.terminalCreate) {
    return { ok: false, message: "terminal API unavailable — restart Vellum Command" };
  }
  const existing = terminal$.sessionByBindingId[binding.bindingId].peek();
  if (existing?.status === "running" || existing?.status === "starting") {
    return { ok: true };
  }
  try {
    const live = await api.terminalGet?.(binding.bindingId, binding.hostId);
    if (live?.status === "running" || live?.status === "starting") {
      terminal$.sessionByBindingId[binding.bindingId].set(live);
      return { ok: true };
    }
  } catch {
    // fall through to create
  }
  try {
    const next = await api.terminalCreate({
      bindingId: binding.bindingId,
      hostId: binding.hostId,
      launch: binding.launch,
      canvasName: state$.canvasName.peek(),
      nodeId: node.id,
      label: binding.label,
      ...(binding.harness ? { harness: binding.harness } : {}),
      ...(binding.agentKey ? { agentKey: binding.agentKey } : {}),
    });
    terminal$.sessionByBindingId[binding.bindingId].set(next);
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: message || "start failed" };
  }
};

/**
 * Ensure session is live, then open the workbench surface.
 * Pass `zone: "pinned"` to land in the side dock (open auto-pinned).
 */
export const openTerminal = async (
  node: CanvasNode,
  zone: WorkZone = "focus",
): Promise<void> => {
  const result = await ensureTerminalRunning(node);
  if (!result.ok) {
    console.error("[terminal] open failed", result.message);
    return;
  }
  openTerminalSurface(node, zone);
};

export const killTerminal = async (node: CanvasNode): Promise<void> => {
  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native") return;
  await getVellumApi()?.terminalKill?.(binding.bindingId, binding.hostId);
  try {
    const next = await getVellumApi()?.terminalGet?.(binding.bindingId, binding.hostId);
    terminal$.sessionByBindingId[binding.bindingId].set(next);
  } catch {
    terminal$.sessionByBindingId[binding.bindingId].set(undefined);
  }
};
