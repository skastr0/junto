/**
 * Terminal open / create / kill — used by the node toolbar and card double-click.
 * Session start is automatic on open; no Start button on the card body.
 */
import type { Node, Seat, Terminal } from "@shared/model";
import { terminalBindingOf, sessionActorMatches } from "@shared/terminal";
import { occupancyFromSummary } from "@shared/terminal-seat-occupancy";
import { markAgentSeatSeen } from "./agent-seat-state";
import { flushPendingCanvasSave } from "./mutations";
import { getJuntoApi } from "./junto-api";
import { state$ } from "./state";
import { nodeAt } from "./use-model";
import type { WorkZone } from "./surface-registry";
import { openTerminalSurface } from "./dock-state";
import { openGridTerminalSurface, terminal$ } from "./terminal-state";

type TerminalActionResult =
  | {
      readonly ok: true;
      /** The host resumed a session it proved exists; else a fresh session. */
      readonly resuming?: boolean;
      /** Generation the host started or reused for an agent seat. */
      readonly epoch?: string;
    }
  | { readonly ok: false; readonly message: string };

export const ensureTerminalRunning = async (
  node: Seat | Terminal,
  options?: { readonly resume?: boolean; readonly canvas?: string },
): Promise<TerminalActionResult> => {
  const entityKind = node.kind;

  if (entityKind === "agent") {
    const surface = terminalBindingOf(node)!;
    const api = getJuntoApi();
    if (!api?.modelStart) {
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
      let next = await api.modelStart({
        canvas: options?.canvas ?? state$.canvasName.peek(),
        id: node.id,
        resume: options?.resume ?? true,
      });
      if (!sessionActorMatches(next, node)) {
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
      return { ok: true, resuming: next.resuming === true, epoch: next.epoch };
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
  const binding = terminalBindingOf(node);
  if (binding?.kind !== "native") {
    return { ok: false, message: "raw terminal is missing its binding" };
  }
  const api = getJuntoApi();
  if (!api?.modelStart) {
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
    // Main starts the terminal from its own row, so a terminal the operator
    // just made has to be committed before it can be started.
    await flushPendingCanvasSave().catch(() => undefined);
    const next = await api.modelStart({
      canvas: options?.canvas ?? state$.canvasName.peek(),
      id: node.id,
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
/**
 * Open the terminal of a seat or a terminal, named by canvas and id: the node
 * is read from the store as it stands at the gesture.
 */
export function openTerminal(
  canvas: string,
  id: string,
  zone?: WorkZone,
  options?: { readonly resume?: boolean },
): Promise<void>;
/** Open a model seat or terminal already held by the caller. */
export function openTerminal(
  node: Seat | Terminal,
  zone?: WorkZone,
  options?: { readonly resume?: boolean },
): Promise<void>;
export function openTerminal(
  first: string | Seat | Terminal,
  second?: string | WorkZone,
  third?: WorkZone | { readonly resume?: boolean },
  fourth?: { readonly resume?: boolean },
): Promise<void> {
  if (typeof first !== "string") {
    return openTerminalNode(first, (second as WorkZone | undefined) ?? "focus", third as { readonly resume?: boolean } | undefined);
  }
  const row = nodeAt(first, second ?? "");
  if (row?.kind !== "agent" && row?.kind !== "terminal") return Promise.resolve();
  return openTerminalNode(row, (third as WorkZone | undefined) ?? "focus", fourth, first);
}

const openTerminalNode = async (
  node: Seat | Terminal,
  zone: WorkZone = "focus",
  options?: { readonly resume?: boolean },
  canvas = state$.canvasName.peek(),
): Promise<void> => {
  const entityKind = node.kind;
  const binding = terminalBindingOf(node);
  if (binding?.kind !== "native") return;

  // Opening is "looking" — clear ready/complete (idle+unseen → idle).
  markAgentSeatSeen(binding.bindingId);

  if (entityKind === "agent") {
    // Surface owns ensure + attach (spinner covers the full path).
    openTerminalSurface(node, zone, canvas);
    return;
  }

  const result = await ensureTerminalRunning(node, { ...options, canvas });
  if (!result.ok) {
    console.error("[terminal] open failed", result.message);
    state$.error.set(`terminal / ${result.message}`);
    // Still open the surface when a generation exists so the operator can
    // read the spawn journal (e.g. unexpanded cwd / missing shell). A total
    // unbound failure leaves the surface closed.
    const session = terminal$.sessionByBindingId[binding.bindingId].peek();
    if (!session) return;
  }
  openTerminalSurface(node, zone, canvas);
};

/**
 * Mount agent seats for the grid focus view. Same demand semantics as a
 * single open: a cold seat starts when its surface attaches. Seats that are
 * already open keep their one live surface; the grid adopts it.
 */
export const openAgentGridTerminals = (nodes: ReadonlyArray<Node>): ReadonlyArray<string> => {
  const opened: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "agent") continue;
    const binding = terminalBindingOf(node);
    if (binding?.kind !== "native") continue;
    markAgentSeatSeen(binding.bindingId);
    openGridTerminalSurface(node, state$.canvasName.peek());
    opened.push(node.id);
  }
  return opened;
};

export const killTerminal = async (node: Seat | Terminal): Promise<void> => {
  const binding = terminalBindingOf(node);
  if (binding?.kind !== "native") return;
  await getJuntoApi()?.terminalKill?.(binding.bindingId, binding.hostId);
  try {
    const next = await getJuntoApi()?.terminalGet?.(binding.bindingId, binding.hostId);
    terminal$.sessionByBindingId[binding.bindingId].set(next);
  } catch {
    terminal$.sessionByBindingId[binding.bindingId].set(undefined);
  }
};
