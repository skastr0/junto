/**
 * Ensure a managed agent seat has a live PTY generation.
 * Used by kernel claim tick so play does not require a prior UI open.
 */

import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import {
  actorDeliverySurfaceOf,
  isManagedAgentNode,
} from "@shared/actor-surface";
import { launchForManagedSpawn } from "./managed-spawn-plan";
import { termPlane } from "./plane";

export const ensureManagedSeatRunning = (
  canvasName: string,
  doc: CanvasDoc,
  node: CanvasNode,
): boolean => {
  // Kind-discriminated: only managedAgent surface starts harness PTYs.
  const surface = actorDeliverySurfaceOf(node);
  if (!surface || surface._tag !== "managedAgent") return false;

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

/** Start every managed actor seat on the canvas. */
export const ensureManagedSeatsForCanvas = (
  canvasName: string,
  doc: CanvasDoc,
): number => {
  let started = 0;
  for (const node of doc.nodes) {
    if (!isManagedAgentNode(node)) continue;
    if (ensureManagedSeatRunning(canvasName, doc, node)) started += 1;
  }
  return started;
};
