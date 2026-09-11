import type { CanvasNode } from "@shared/canvas";
import type { CanvasOverseerSetResult } from "@shared/ipc";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { flushCanvasEdits } from "./canvas-editor-flush";
import { getCanvasRevision } from "./mutations";
import { state$ } from "./state";
import { getVellumCommandApi } from "./vellum-api";

/** Managed executable agent seat — the only UI-eligible overseer target. */
export const isManagedAgentSeat = (node: CanvasNode): boolean => {
  if (node.ether?.entity?.kind !== "agent") return false;
  const harness = node.ether.terminal?.harness;
  return typeof harness === "string" && isHarnessId(harness);
};

/** Live grant on the node. Absent or false is not overseer. */
export const isOverseerGranted = (node: CanvasNode): boolean =>
  node.ether?.overseer === true;

/** Granted overseer identity — managed agent seats only. */
export const isOverseerSeat = (node: CanvasNode): boolean =>
  isManagedAgentSeat(node) && isOverseerGranted(node);

/** Human Command Center authoring may grant/revoke; Remote station never. */
export const canToggleOverseer = (node: CanvasNode): boolean =>
  isManagedAgentSeat(node) && state$.settings.station.role.peek() !== "remote";

export class OverseerSetError extends Error {
  override readonly name = "OverseerSetError";
}

/**
 * Human-only immediate grant/revoke. Flushes local drafts, then calls
 * canvasOverseerSet. Never writes ether.overseer through writeCanvas and
 * never moves the viewport — canvasChanged reloads the committed grant.
 */
export const setOverseerSeat = async (input: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly overseer: boolean;
}): Promise<CanvasOverseerSetResult> => {
  const api = getVellumCommandApi();
  if (typeof api?.canvasOverseerSet !== "function") {
    throw new OverseerSetError("Overseer control is unavailable.");
  }
  await flushCanvasEdits();
  const expectedRevision = getCanvasRevision(input.canvasName);
  if (expectedRevision === undefined) {
    throw new OverseerSetError("Reload before changing overseer.");
  }
  return api.canvasOverseerSet({
    canvasName: input.canvasName,
    nodeId: input.nodeId,
    overseer: input.overseer,
    expectedRevision,
  });
};
