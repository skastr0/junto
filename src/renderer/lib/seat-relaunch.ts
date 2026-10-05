/**
 * Restart a managed seat with new starting parameters.
 *
 * Unlike a re-seat this keeps the seat whole: same binding, same session id,
 * so the harness resumes its conversation on the new parameters. The stored
 * launch is committed BEFORE the old process is stopped, so nothing that
 * wakes the seat in between can start it on the old parameters.
 */
import type { TextNode } from "@shared/canvas";
import type { RejectedExtraArg } from "@shared/launch-extra-args";
import {
  relaunchManagedAgentNode,
  type SeatLaunchParams,
} from "@shared/seat-launch-params";
import { resolveTerminalBinding } from "@shared/terminal";
import { getJuntoApi } from "./junto-api";
import { applyManagedAgentReseat, flushPendingCanvasSave } from "./mutations";
import {
  ensureTerminalRunning,
  killTerminal,
  openTerminal,
} from "./terminal-actions";
import { closeTerminalSurface, terminal$ } from "./terminal-state";
import { closeWorkbenchSurface, terminalSurfaceId } from "./dock-state";

/** How long a stopping harness gets before the restart is reported as stuck. */
const EXIT_WAIT_MS = 15_000;
const EXIT_POLL_MS = 100;

export type SeatRelaunchResult =
  | {
      readonly ok: true;
      /** The harness was running and has been started again. */
      readonly restarted: boolean;
      readonly rejected: readonly RejectedExtraArg[];
    }
  | { readonly ok: false; readonly message: string };

const isLive = (status: string | undefined): boolean =>
  status === "running" || status === "starting";

const waitForExit = async (
  bindingId: string,
  hostId: string | undefined,
): Promise<boolean> => {
  const api = getJuntoApi();
  if (!api?.terminalGet) return true;
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (Date.now() < deadline) {
    const session = await api.terminalGet(bindingId, hostId).catch(() => undefined);
    if (!session || !isLive(session.status)) {
      terminal$.sessionByBindingId[bindingId].set(session);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
  }
  return false;
};

export const performSeatRelaunch = async (
  node: TextNode,
  params: SeatLaunchParams,
): Promise<SeatRelaunchResult> => {
  const relaunched = relaunchManagedAgentNode(node, params);
  if (!relaunched) return { ok: false, message: "not a managed agent seat" };
  const next = relaunched.node;
  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native") {
    return { ok: false, message: "seat has no terminal binding" };
  }

  const api = getJuntoApi();
  const before = await api
    ?.terminalGet?.(binding.bindingId, binding.hostId)
    .catch(() => undefined);
  const wasRunning = isLive(before?.status);
  const surfaceWasOpen = Boolean(terminal$.openByNodeId[node.id].peek());

  applyManagedAgentReseat(next);
  await flushPendingCanvasSave().catch(() => undefined);

  if (!wasRunning) {
    // Nothing to restart: the next start uses the stored parameters.
    return { ok: true, restarted: false, rejected: relaunched.rejected };
  }

  // The open surface would otherwise watch its own process die and offer a
  // reopen while this restart is already under way.
  if (surfaceWasOpen) {
    closeWorkbenchSurface(terminalSurfaceId(node.id));
    closeTerminalSurface(node.id);
  }

  try {
    await killTerminal(node);
  } catch (error: unknown) {
    return {
      ok: false,
      message: `could not stop the running harness: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!(await waitForExit(binding.bindingId, binding.hostId))) {
    return {
      ok: false,
      message:
        "the harness is still stopping; the new parameters are saved and apply on its next start",
    };
  }

  if (surfaceWasOpen) {
    // The surface owns ensure + attach, and resumes the seat's session.
    await openTerminal(next, "focus");
    return { ok: true, restarted: true, rejected: relaunched.rejected };
  }
  const started = await ensureTerminalRunning(next, { resume: true });
  if (!started.ok) return { ok: false, message: started.message };
  return { ok: true, restarted: true, rejected: relaunched.rejected };
};
