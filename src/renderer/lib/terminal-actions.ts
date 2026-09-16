/**
 * Terminal open / create / kill — used by the node toolbar and card double-click.
 * Session start is automatic on open; no Start button on the card body.
 */
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import type { CanvasNode } from "@shared/canvas";
import { resolveTerminalBinding, sessionActorMatches } from "@shared/terminal";
import { occupancyFromSummary } from "@shared/terminal-seat-occupancy";
import { markAgentSeatSeen } from "./agent-seat-state";
import { flushPendingCanvasSave } from "./mutations";
import { getVellumCommandApi } from "./vellum-api";
import { state$ } from "./state";
import type { WorkZone } from "./surface-registry";
import { openTerminalSurface, terminal$ } from "./terminal-state";

const missingActorSurfaceMessage =
  "agent seat is incomplete — add an agent name, terminal binding, and harness";

type TerminalActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export const ensureTerminalRunning = async (
  node: CanvasNode,
  options?: { readonly resume?: boolean },
): Promise<TerminalActionResult> => {
  const entityKind = node.ether?.entity?.kind;

  if (entityKind === "agent") {
    const surface = actorDeliverySurfaceOf(node);
    if (!surface) {
      return { ok: false, message: missingActorSurfaceMessage };
    }
    const api = getVellumCommandApi();
    if (!api?.terminalCreate) {
      return { ok: false, message: "terminal API unavailable — restart Junto" };
    }
    try {
      // Commit the debounced canvas write first: Remote seat admission in
      // Main evaluates committed authorial state and holds occupation behind
      // the destination's projection acknowledgement of exactly that state.
      // A failed save still surfaces through the save-state chrome; the
      // admission verdict below stays truthful about what was committed.
      await flushPendingCanvasSave().catch(() => undefined);
      // Main owns ActorSeatOccupy, including occupied-vs-vacant WHEN. Always
      // send the node-derived actor command; a cached renderer summary is not
      // authority to skip occupation or reconstruct a geography shell.
      let next = await api.terminalCreate({
        node,
        canvasName: state$.canvasName.peek(),
        resume: options?.resume ?? true,
      });
      if (!sessionActorMatches(next, surface)) {
        return {
          ok: false,
          message: "actor seat did not bind the requested identity",
        };
      }
      // A resume generation can die and be fail-open replaced before or just
      // after occupy returns. Prefer the live binding head over a stale exited
      // snapshot so the surface does not paint dead while a pin is already up.
      if (next.status === "exited") {
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline) {
          const live = await api.terminalGet?.(surface.bindingId, surface.hostId);
          if (live && (live.status === "running" || live.status === "starting")) {
            next = live;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      terminal$.sessionByBindingId[surface.bindingId].set(next);
      if (next.status === "exited") {
        return {
          ok: false,
          message: next.exitMessage ?? "agent exited immediately after spawn",
        };
      }
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: message || "start failed" };
    }
  }

  // Raw native terminals are geography. Optional terminal fields can never
  // promote another kind into this arm.
  if (entityKind !== "terminal") {
    return { ok: false, message: "unbound terminal" };
  }
  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native") {
    return { ok: false, message: "raw terminal is missing its binding" };
  }
  const api = getVellumCommandApi();
  if (!api?.terminalCreate) {
    return { ok: false, message: "terminal API unavailable — restart Junto" };
  }

  // Geography keeps its attach-or-create shortcut. Actor occupation above is
  // deliberately unconditional and delegates WHEN to ActorSeatOccupy in Main.
  let live: Awaited<ReturnType<NonNullable<typeof api.terminalGet>>> | undefined;
  try {
    live = await api.terminalGet?.(binding.bindingId, binding.hostId);
  } catch {
    live = undefined;
  }
  const occupancy = occupancyFromSummary(binding.bindingId, live);
  if (occupancy._tag === "OccupiedSeat" && live) {
    terminal$.sessionByBindingId[binding.bindingId].set(live);
    return { ok: true };
  }

  try {
    const next = await api.terminalCreate({
      node,
      canvasName: state$.canvasName.peek(),
    });
    terminal$.sessionByBindingId[binding.bindingId].set(next);
    // Create is still allowed to open the surface for journal/error replay
    // when the generation dies before the first attach (bad cwd, missing
    // shell). Callers that only need a live seat treat exited as failure.
    if (next.status === "exited") {
      return {
        ok: false,
        message: next.exitMessage ?? "terminal exited immediately after spawn",
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
  const entityKind = node.ether?.entity?.kind;
  if (entityKind === "agent" && !actorDeliverySurfaceOf(node)) {
    // An authored actor never degrades into a shell. The global warning is a
    // visible correction path even though an incomplete node has no terminal
    // binding with which to mount the normal surface error chrome.
    state$.error.set(`terminal / ${missingActorSurfaceMessage}`);
    return;
  }
  if (entityKind !== "agent" && entityKind !== "terminal") return;

  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native") return;

  // Opening is "looking" — clear ready/complete (idle+unseen → idle).
  markAgentSeatSeen(binding.bindingId);

  if (entityKind === "agent") {
    // Surface owns ensure + attach (spinner covers the full path).
    openTerminalSurface(node, zone, state$.canvasName.peek());
    return;
  }

  const result = await ensureTerminalRunning(node, options);
  if (!result.ok) {
    console.error("[terminal] open failed", result.message);
    state$.error.set(`terminal / ${result.message}`);
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
