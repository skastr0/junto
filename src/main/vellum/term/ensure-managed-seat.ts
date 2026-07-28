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

export type ManagedSeatRuntimeAuthority = {
  readonly actor: ActorRef;
  readonly installationId: InstallationId;
  readonly hostId: string;
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
  if (live?.status === "running" || live?.status === "starting") return true;

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
