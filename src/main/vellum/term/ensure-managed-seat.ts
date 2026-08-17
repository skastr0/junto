/**
 * Ensure a managed agent seat has a live PTY generation.
 * Used by kernel claim tick so play does not require a prior UI open.
 */

import { Effect } from "effect";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import type { InstallationId } from "@shared/installation-id";
import type { ActorRef } from "@shared/work-protocol";
import { deriveActorSeatId } from "../station/actor-seat-compiler";
import { launchForManagedSpawn } from "./managed-spawn-plan";
import { termPlane } from "./plane";
import { seatStateRuntime } from "./agent-state";
import type {
  ActorOccupySpec,
  ActorSeatOccupyApi,
} from "./actor-seat-occupy";

export type ManagedSeatRuntimeAuthority = {
  readonly actor: ActorRef;
  readonly installationId: InstallationId;
  readonly hostId: string;
};

/** Automatic restarts allowed per binding per process lifetime. */
export const AUTO_RESTART_MAX = 3;
/**
 * Minimum quiet time before automatic restart N+1 (indexed by restarts already
 * spent). First restart is immediate — a seat that died with the app closed or
 * crashed once must be wakeable by mail without a human click.
 */
export const AUTO_RESTART_BACKOFF_MS = [0, 30_000, 300_000] as const;

export type AutoRestartBudget = {
  readonly restarts: number;
  readonly lastRestartAtMs: number;
};

export type ManagedSeatWakeDecision =
  | { readonly kind: "reuse" }
  | { readonly kind: "spawn"; readonly restart: boolean }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * ONE rule: mail wakes seats. A dead seat — stopped, crashed, app-restarted,
 * it does not matter — is started by any demand signal (mail, board wake,
 * task claim) under a bounded per-binding budget with backoff. No hidden
 * stop-provenance decides behavior. The only refusals are mechanical: the
 * budget is exhausted (crash loop converges to "needs a look"), the binary
 * cannot spawn (missing CLI will not fix itself), or the old process is
 * still mid-exit (the deferred retry catches it seconds later).
 */
export const managedSeatWakeDecision = (input: {
  readonly status: "starting" | "running" | "exited" | "missing" | undefined;
  /** A kill signal is in flight for this generation. */
  readonly stopping: boolean;
  readonly exitReason?: "cli-missing" | "spawn_failed" | undefined;
  readonly budget: AutoRestartBudget | undefined;
  readonly nowMs: number;
}): ManagedSeatWakeDecision => {
  if (input.stopping && input.status !== "exited") {
    // Mechanical, transient: the previous process is still dying. Never two
    // processes on one binding — the deferred retry lands after the exit.
    return {
      kind: "refuse",
      reason: "previous process is still exiting — delivery retries shortly",
    };
  }
  if (!input.stopping && (input.status === "starting" || input.status === "running")) {
    return { kind: "reuse" };
  }
  if (input.status === undefined) {
    return { kind: "spawn", restart: false };
  }
  if (input.status === "missing") {
    return {
      kind: "refuse",
      reason: "generation state is unknown for this host — reopen the terminal",
    };
  }
  if (input.exitReason !== undefined) {
    return {
      kind: "refuse",
      reason: `harness failed before ownership (${input.exitReason}) — fix the launch and reopen the terminal`,
    };
  }
  const budget = input.budget;
  if (budget === undefined) {
    return { kind: "spawn", restart: true };
  }
  if (budget.restarts >= AUTO_RESTART_MAX) {
    return {
      kind: "refuse",
      reason: `automatic restart budget exhausted (${String(budget.restarts)} restarts) — reopen the terminal to restart`,
    };
  }
  const wait =
    AUTO_RESTART_BACKOFF_MS[
      Math.min(budget.restarts, AUTO_RESTART_BACKOFF_MS.length - 1)
    ]!;
  const since = input.nowMs - budget.lastRestartAtMs;
  if (since < wait) {
    return {
      kind: "refuse",
      reason: `automatic restart backing off (${String(Math.ceil((wait - since) / 1000))}s remaining)`,
    };
  }
  return { kind: "spawn", restart: true };
};

/** Per-binding automatic-restart spend. Process-local, like the host map. */
const autoRestartBudgets = new Map<string, AutoRestartBudget>();

/** Test seam — forget all automatic-restart spend. */
export const resetAutoRestartBudgetsForTest = (): void => {
  autoRestartBudgets.clear();
};

/**
 * Prove that a compiled actor reference names this installation's executable
 * seat before any host process is inspected or created.
 *
 * HostId is authored placement; ActorSeatId binds that placement to the
 * durable InstallationId and terminal binding. Both must agree. A complete
 * Remote projection therefore remains safe to inspect without accidentally
 * starting a foreign actor.
 */
export const isManagedSeatRuntimeLocal = (
  canvasName: string,
  node: CanvasNode,
  authority: ManagedSeatRuntimeAuthority,
): boolean => {
  const surface = actorDeliverySurfaceOf(node);
  if (surface?._tag !== "managedAgent") return false;
  if (
    authority.actor.canvasName !== canvasName ||
    authority.actor.nodeId !== node.id ||
    surface.hostId !== authority.hostId
  ) {
    return false;
  }
  return (
    deriveActorSeatId(authority.installationId, surface.bindingId) ===
    authority.actor.seatId
  );
};

/**
 * Claim admission for a local managed seat. Identity locality alone is not
 * enough: the exact live generation must be running and observer-confirmed
 * idle before durable work can move to `working`.
 */
export const localManagedSeatReadyForClaim = (
  bindingId: string,
): boolean => {
  const live = termPlane.host.get(bindingId);
  return (
    live?.status === "running" &&
    seatStateRuntime.isSeatIdle(bindingId)
  );
};

export const ensureManagedSeatRunning = (
  canvasName: string,
  doc: CanvasDoc,
  node: CanvasNode,
  authority: ManagedSeatRuntimeAuthority,
  actorSeatOccupy: ActorSeatOccupyApi,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!isManagedSeatRuntimeLocal(canvasName, node, authority)) {
      console.error(
        `[wake] refused ${canvasName}/${node.id}: seat identity is not local to this installation`,
      );
      return false;
    }

    // The locality proof above already established this exact managed surface.
    const surface = actorDeliverySurfaceOf(node);
    if (surface?._tag !== "managedAgent") return false;

    const occupy = (spec: ActorOccupySpec): Effect.Effect<boolean> =>
      actorSeatOccupy.occupy(spec).pipe(
        Effect.match({
          onFailure: (error) => {
            console.error(
              `[term] ensureManagedSeatRunning failed for ${surface.bindingId}:`,
              error,
            );
            return false;
          },
          onSuccess: () => true,
        }),
      );
    const baseSpec: ActorOccupySpec = {
      bindingId: surface.bindingId,
      hostId: surface.hostId,
      canvasName,
      nodeId: node.id,
      label: node.ether?.terminal?.label,
      harness: surface.harness,
      agentKey: surface.agentKey,
      ...(surface.launch === undefined ? {} : { launch: surface.launch }),
    };

    const live = termPlane.host.get(surface.bindingId);
    const decision = managedSeatWakeDecision({
      status: live?.status,
      stopping: live?.stopping === true,
      exitReason: live?.exitReason,
      budget: autoRestartBudgets.get(surface.bindingId),
      nowMs: Date.now(),
    });
    if (decision.kind === "reuse") {
      // Occupied does not mean actor-bound. The single WHEN adopts a compatible
      // live geography generation without replacing its epoch.
      const activated = yield* occupy(baseSpec);
      if (activated) autoRestartBudgets.delete(surface.bindingId);
      return activated;
    }
    if (decision.kind === "refuse") {
      console.error(
        `[wake] refused ${canvasName}/${node.id} (${surface.bindingId}): ${decision.reason}`,
      );
      return false;
    }
    if (decision.restart) {
      const spent = autoRestartBudgets.get(surface.bindingId);
      autoRestartBudgets.set(surface.bindingId, {
        restarts: (spent?.restarts ?? 0) + 1,
        lastRestartAtMs: Date.now(),
      });
    }

    const planned = launchForManagedSpawn({
      doc,
      nodeId: node.id,
      harness: surface.harness,
      documentLaunch: surface.launch,
      agentKey: surface.agentKey,
      cwd: surface.launch?.cwd,
      resume: true,
    });
    const launch = planned.launch ?? surface.launch;

    return yield* occupy({
      ...baseSpec,
      ...(launch === undefined ? {} : { launch }),
      ...(planned.plan?.firstTypedMessage
        ? { firstTypedMessage: planned.plan.firstTypedMessage }
        : {}),
    });
  });
