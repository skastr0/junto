import type { CanvasNode } from "@shared/canvas";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { flushCanvasEdits } from "./canvas-editor-flush";
import { asCanvasName, asNodeId } from "@shared/model";
import { modelStore } from "./use-model";
import { state$ } from "./state";
import { getJuntoApi } from "./junto-api";

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
 * Human-only immediate grant or revoke. The operator's toggle is the
 * GrantOverseer command, sent as it is: main admits it only from the operator,
 * applies it to every alias of the seat at once, and refuses it from anyone
 * else. It is not part of undo, and it never rides along with another edit.
 * Local drafts are committed and sent first, so the grant lands on the canvas
 * the operator is looking at.
 */
export const setOverseerSeat = async (input: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly overseer: boolean;
}): Promise<void> => {
  if (typeof getJuntoApi()?.modelCommand !== "function") {
    throw new OverseerSetError("Overseer control is unavailable.");
  }
  await flushCanvasEdits("background");
  await modelStore.send({
    _tag: "GrantOverseer",
    canvas: asCanvasName(input.canvasName),
    id: asNodeId(input.nodeId),
    overseer: input.overseer,
  });
};
