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
import { terminal$ } from "./terminal-state";
import { closeTerminalView } from "./dock-state";

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

type RestartOutcome =
  | { readonly ok: true; readonly restarted: boolean }
  | { readonly ok: false; readonly message: string };

/**
 * Stop the seat's running harness and start it again on the same binding and
 * the same session. `next` is the node the seat starts from: the same node,
 * or one whose stored launch has just been committed. `savedForNextStart`
 * finishes the sentence when the old process will not stop in time.
 *
 * A seat that is not running is left alone: its next start reads whatever is
 * current by itself.
 */
const restartRunningSeat = async (
  node: TextNode,
  next: TextNode,
  wasRunning: boolean,
  savedForNextStart: string,
): Promise<RestartOutcome> => {
  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native") {
    return { ok: false, message: "seat has no terminal binding" };
  }
  if (!wasRunning) return { ok: true, restarted: false };
  const surfaceWasOpen = Boolean(terminal$.openByNodeId[node.id].peek());

  // The open surface would otherwise watch its own process die and offer a
  // reopen while this restart is already under way.
  if (surfaceWasOpen) {
    closeTerminalView(node.id);
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
      message: `the harness is still stopping; ${savedForNextStart}`,
    };
  }

  if (surfaceWasOpen) {
    // The surface owns ensure + attach, and resumes the seat's session.
    await openTerminal(next, "focus");
    return { ok: true, restarted: true };
  }
  const started = await ensureTerminalRunning(next, { resume: true });
  if (!started.ok) return { ok: false, message: started.message };
  return { ok: true, restarted: true };
};

const isRunning = async (node: TextNode): Promise<boolean> => {
  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native") return false;
  const session = await getJuntoApi()
    ?.terminalGet?.(binding.bindingId, binding.hostId)
    .catch(() => undefined);
  return isLive(session?.status);
};

/**
 * Restart a running seat as it is, so it picks up what is read at launch (its
 * regions' environment). Same binding, same session: the harness resumes its
 * conversation. Nothing about the seat's stored launch changes.
 */
export const restartSeatOnSameSession = async (
  node: TextNode,
): Promise<RestartOutcome> =>
  restartRunningSeat(
    node,
    node,
    await isRunning(node),
    "it starts on the current environment the next time it starts",
  );

export const performSeatRelaunch = async (
  node: TextNode,
  params: SeatLaunchParams,
): Promise<SeatRelaunchResult> => {
  const relaunched = relaunchManagedAgentNode(node, params);
  if (!relaunched) return { ok: false, message: "not a managed agent seat" };
  const next = relaunched.node;
  if (resolveTerminalBinding(node)?.kind !== "native") {
    return { ok: false, message: "seat has no terminal binding" };
  }
  const wasRunning = await isRunning(node);

  // Committed BEFORE the old process stops, so nothing that wakes the seat in
  // between can start it on the old parameters.
  applyManagedAgentReseat(next);
  await flushPendingCanvasSave().catch(() => undefined);

  const outcome = await restartRunningSeat(
    node,
    next,
    wasRunning,
    "the new parameters are saved and apply on its next start",
  );
  if (!outcome.ok) return outcome;
  return { ok: true, restarted: outcome.restarted, rejected: relaunched.rejected };
};
