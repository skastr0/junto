/**
 * Terminal open / create / kill — used by the node toolbar and card double-click.
 * Session start is automatic on open; no Start button on the card body.
 */
import type { CanvasNode } from "@shared/canvas";
import { resolveTerminalBinding } from "@shared/terminal";
import { occupancyFromSummary } from "@shared/terminal-seat-occupancy";
import { markAgentSeatSeen } from "./agent-seat-state";
import { getVellumCommandApi } from "./vellum-api";
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
  const api = getVellumCommandApi();
  if (!api?.terminalCreate) {
    return { ok: false, message: "terminal API unavailable — restart Vellum Command" };
  }
  // Occupied seats activate; they are never occupied again. Stopping still
  // occupies the seat. Vacant (exited / missing / unknown) is the only
  // create path.
  try {
    const live = await api.terminalGet?.(binding.bindingId, binding.hostId);
    const occupancy = occupancyFromSummary(binding.bindingId, live);
    if (occupancy._tag === "OccupiedSeat" && live) {
      if (binding.harness && binding.agentKey) {
        // Live PTY may have been occupied as geography. Re-enter create so
        // the spawn host can adopt actor identity without respawning.
        try {
          const adopted = await api.terminalCreate({
            bindingId: binding.bindingId,
            hostId: binding.hostId,
            launch: binding.launch,
            canvasName: state$.canvasName.peek(),
            nodeId: node.id,
            label: binding.label,
            harness: binding.harness,
            agentKey: binding.agentKey,
          });
          terminal$.sessionByBindingId[binding.bindingId].set(adopted);
          return { ok: true };
        } catch {
          terminal$.sessionByBindingId[binding.bindingId].set(live);
          return { ok: true };
        }
      }
      terminal$.sessionByBindingId[binding.bindingId].set(live);
      return { ok: true };
    }
  } catch {
    // fall through to occupy
  }
  try {
    let next = await api.terminalCreate({
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
    // A resume generation can die and be fail-open replaced before or just
    // after create returns. Prefer the live binding head over a stale exited
    // snapshot so the surface does not paint dead while a pin is already up.
    if (next.status === "exited" && binding.harness) {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const live = await api.terminalGet?.(binding.bindingId, binding.hostId);
        if (live && (live.status === "running" || live.status === "starting")) {
          next = live;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
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
 * Open the workbench surface for a terminal / actor seat.
 * Pass `zone: "pinned"` to land in the side dock (open auto-pinned).
 *
 * Agent seats open the surface first so the session-load spinner can paint
 * while ensure + attach run inside TerminalSurface. Geography shells still
 * ensure before open (no actor load chrome).
 */
export const openTerminal = async (
  node: CanvasNode,
  zone: WorkZone = "focus",
  options?: { readonly resume?: boolean },
): Promise<void> => {
  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native") return;

  const agentSeat = Boolean(
    binding.harness?.trim() || binding.agentKey?.trim(),
  );

  // Opening is "looking" — clear ready/complete (idle+unseen → idle), herdr-style.
  markAgentSeatSeen(binding.bindingId);

  if (agentSeat) {
    // Surface owns ensure + attach (spinner covers the full path).
    openTerminalSurface(node, zone, state$.canvasName.peek());
    return;
  }

  const result = await ensureTerminalRunning(node, options);
  if (!result.ok) {
    console.error("[terminal] open failed", result.message);
    // Still open the surface when a generation exists so the operator can
    // read the spawn journal (e.g. unexpanded cwd / missing shell). A total
    // unbound failure leaves the surface closed.
    const session = terminal$.sessionByBindingId[binding.bindingId].peek();
    if (!session) return;
  }
  openTerminalSurface(node, zone, state$.canvasName.peek());
};

export const killTerminal = async (node: CanvasNode): Promise<void> => {
  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native") return;
  await getVellumCommandApi()?.terminalKill?.(binding.bindingId, binding.hostId);
  try {
    const next = await getVellumCommandApi()?.terminalGet?.(binding.bindingId, binding.hostId);
    terminal$.sessionByBindingId[binding.bindingId].set(next);
  } catch {
    terminal$.sessionByBindingId[binding.bindingId].set(undefined);
  }
};
