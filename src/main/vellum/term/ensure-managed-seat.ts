/**
 * Ensure a managed agent seat has a live PTY generation.
 * Used by kernel claim tick so play does not require a prior UI open.
 */

import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import type { InstallationId } from "@shared/installation-id";
import type { ActorRef } from "@shared/work-protocol";
import { deriveActorSeatId } from "../station/actor-seat-compiler";
import { launchForManagedSpawn } from "./managed-spawn-plan";
import { termPlane } from "./plane";
import { seatStateRuntime } from "./agent-state";

export type ManagedSeatRuntimeAuthority = {
  readonly actor: ActorRef;
  readonly installationId: InstallationId;
  readonly hostId: string;
};

export type AutomaticManagedSeatDisposition =
  | "create-initial-generation"
  | "reuse-live-generation"
  | "require-explicit-restart";

/**
 * Automatic factory operation owns first start and prompt injection, not
 * process supervision. An exited generation is durable negative evidence:
 * replacing it on every kernel repair cycle can turn a harness failure (or an
 * operator kill) into an unbounded crash loop.
 *
 * The renderer's explicit terminal-open action remains the restart authority.
 */
export const automaticManagedSeatDisposition = (
  status: "starting" | "running" | "exited" | "missing" | undefined,
): AutomaticManagedSeatDisposition => {
  if (status === undefined) return "create-initial-generation";
  if (status === "starting" || status === "running") {
    return "reuse-live-generation";
  }
  return "require-explicit-restart";
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
): boolean => {
  if (!isManagedSeatRuntimeLocal(canvasName, node, authority)) return false;

  // The locality proof above already established this exact managed surface.
  const surface = actorDeliverySurfaceOf(node);
  if (surface?._tag !== "managedAgent") return false;

  const live = termPlane.host.get(surface.bindingId);
  // Automatic factory repair never replaces a generation the operator (or
  // shutdown) has stopped. Explicit renderer open owns that restart.
  if (live?.stopping) return false;
  const disposition = automaticManagedSeatDisposition(live?.status);
  if (disposition === "reuse-live-generation") return true;
  if (disposition === "require-explicit-restart") return false;

  const planned = launchForManagedSpawn({
    doc,
    nodeId: node.id,
    harness: surface.harness,
    documentLaunch: surface.launch,
    agentKey: surface.agentKey,
    cwd: surface.launch?.cwd,
  });

  try {
    termPlane.host.createAgentSeat({
      bindingId: surface.bindingId,
      hostId: surface.hostId,
      launch: planned.launch ?? surface.launch,
      canvasName,
      nodeId: node.id,
      label: node.ether?.terminal?.label,
      harness: surface.harness,
      agentKey: surface.agentKey,
      ...(planned.plan?.firstTypedMessage
        ? { firstTypedMessage: planned.plan.firstTypedMessage }
        : {}),
    });
    return true;
  } catch (err) {
    console.error(
      `[term] ensureManagedSeatRunning failed for ${surface.bindingId}:`,
      err,
    );
    return false;
  }
};
