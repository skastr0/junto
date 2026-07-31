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
  options?: { readonly resume?: boolean },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native") {
    return { ok: false, message: "unbound terminal" };
  }
  const api = getVellumApi();
  if (!api?.terminalCreate) {
    return { ok: false, message: "terminal API unavailable — restart Vellum Command" };
  }
  // Renderer state is a display cache, not process authority. In particular,
  // a kill issued from the focused surface used to leave a cached "running"
  // row here, so every reopen attached to the already-revoked generation.
  try {
    const live = await api.terminalGet?.(binding.bindingId, binding.hostId);
    if (
      !live?.stopping &&
      (live?.status === "running" || live?.status === "starting")
    ) {
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
      ...(binding.harness
        ? { resume: options?.resume ?? true }
        : {}),
    });
    terminal$.sessionByBindingId[binding.bindingId].set(next);
    // Create is still allowed to open the surface for journal/error replay
    // when the generation dies before the first attach (bad cwd, missing
    // shell). Callers that only need a live seat treat exited as failure.
    if (next.status === "exited") {
      return {
        ok: false,
        message:
          next.exitMessage ?? "terminal exited immediately after spawn",
      };
    }
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
  options?: { readonly resume?: boolean },
): Promise<void> => {
  const result = await ensureTerminalRunning(node, options);
  if (!result.ok) {
    console.error("[terminal] open failed", result.message);
    // Still open the surface when a generation exists so the operator can
    // read the spawn journal (e.g. unexpanded cwd / missing shell). A total
    // unbound failure leaves the surface closed.
    const binding = resolveTerminalBinding(node);
    if (binding?.kind !== "native") return;
    const session = terminal$.sessionByBindingId[binding.bindingId].peek();
    if (!session) return;
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
