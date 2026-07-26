/**
 * Ensure a managed agent seat has a live PTY generation.
 * Used by kernel claim tick so play does not require a prior UI open.
 */

import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { launchForManagedSpawn } from "./managed-spawn-plan";
import { termPlane } from "./plane";

export const ensureManagedSeatRunning = (
  canvasName: string,
  doc: CanvasDoc,
  node: CanvasNode,
): boolean => {
  const terminal = node.ether?.terminal;
  const bindingId = terminal?.bindingId?.trim();
  const harness = terminal?.harness?.trim();
  if (!bindingId || !harness) return false;

  const live = termPlane.host.get(bindingId);
  if (live?.status === "running" || live?.status === "starting") return true;

  const agentKey =
    node.ether?.entity?.kind === "agent"
      ? node.ether.entity.name?.trim()
      : undefined;

  const planned = launchForManagedSpawn({
    doc,
    nodeId: node.id,
    harness,
    documentLaunch: terminal?.launch,
    agentKey,
    cwd: terminal?.launch?.cwd,
  });

  try {
    termPlane.host.create({
      bindingId,
      hostId: "local",
      launch: planned.launch ?? terminal?.launch,
      canvasName,
      nodeId: node.id,
      label: terminal?.label,
      harness,
      ...(agentKey ? { agentKey } : {}),
      ...(planned.plan?.firstTypedMessage
        ? { firstTypedMessage: planned.plan.firstTypedMessage }
        : {}),
    });
    return true;
  } catch (err) {
    console.error(
      `[term] ensureManagedSeatRunning failed for ${bindingId}:`,
      err,
    );
    return false;
  }
};

/** Start every free managed actor on the canvas that has a terminal binding. */
export const ensureManagedSeatsForCanvas = (
  canvasName: string,
  doc: CanvasDoc,
): number => {
  let started = 0;
  for (const node of doc.nodes) {
    if (node.ether?.entity?.kind !== "agent") continue;
    if (!node.ether.terminal?.bindingId || !node.ether.terminal.harness) continue;
    if (ensureManagedSeatRunning(canvasName, doc, node)) started += 1;
  }
  return started;
};
