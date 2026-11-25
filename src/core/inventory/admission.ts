/**
 * Who may ask a machine about its harnesses, and which canvas the native
 * config channels name. The inventory channel admits by the pin alone: the
 * peer is pinned and active with the installation id its hello carried, it
 * names nothing, and the link is open before and after. Native config and
 * settings admit as Stop does: the same pin, editing the named canvas, and
 * that canvas has a seat on this machine. Identity comes from the admitted
 * hello, never from the payload.
 */
import { Effect } from "effect";
import { isThisMachine } from "@shared/machine-name";
import type { LinkChannelContext } from "../link/types";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { InventoryCanvasEditorMismatch, InventoryLinkClosed, InventoryNoSeatHere, InventoryPeerNotPinned } from "./wire";

const whereOf = (context: LinkChannelContext, machine: string) => ({
  machine,
  ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
});

// Before and after the checks, as a seat is admitted: a link closed meanwhile admits nothing.
const openLink = (context: LinkChannelContext, where: ReturnType<typeof whereOf>) =>
  context.signal.aborted
    ? Effect.fail(new InventoryLinkClosed({ ...where, message: "This machine link has closed." }))
    : Effect.void;

/** The inventory channel's admission: a pinned and active peer on an open link, naming nothing. */
export const admitPinnedPeer = Effect.fn("InventoryLink.admitPinned")(function* (
  context: LinkChannelContext,
  machine: string,
) {
  const machines = yield* MachineRepository;
  const where = whereOf(context, machine);
  yield* openLink(context, where);
  const peer = yield* machines.peer(context.peer.machineName);
  if (peer?.installationId !== context.peer.installationId)
    return yield* new InventoryPeerNotPinned({ ...where, message: "The asking machine is no longer pinned." });
  yield* openLink(context, where);
});

export const admitCanvasEditor = Effect.fn("InventoryLink.admit")(function* (
  context: LinkChannelContext,
  canvas: string,
  machine: string,
) {
  const model = yield* ModelService;
  const records = yield* ModelRecords;
  const machines = yield* MachineRepository;
  const where = whereOf(context, machine);
  yield* openLink(context, where);
  const peer = yield* machines.peer(context.peer.machineName);
  if (peer?.installationId !== context.peer.installationId)
    return yield* new InventoryPeerNotPinned({ ...where, message: "The asking machine is no longer pinned." });
  if ((yield* records.canvasEditor(canvas)) !== context.peer.installationId)
    return yield* new InventoryCanvasEditorMismatch({
      ...where,
      message: "Only the machine editing this canvas may ask about its seats' machine.",
    });
  const held = yield* model.canvas(canvas);
  if (![...held.nodes.values()].some((node) => node.kind === "agent" && isThisMachine(node.host, machine)))
    return yield* new InventoryNoSeatHere({ ...where, message: "This canvas has no seat on this machine." });
  yield* openLink(context, where);
});

/** A canvas this machine edits with a seat on that machine: the only thing a request names. */
export const canvasWithSeatOn = Effect.fn("InventoryLink.canvasFor")(function* (machine: string) {
  const model = yield* ModelService;
  const records = yield* ModelRecords;
  const self = yield* (yield* MachineRepository).installationId;
  for (const name of yield* model.listCanvases()) {
    if ((yield* records.canvasEditor(name)) !== self) continue;
    for (const node of (yield* model.canvas(name)).nodes.values()) {
      if (node.kind === "agent" && isThisMachine(node.host, machine)) return name;
    }
  }
  return undefined;
});

const tagPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** A cause's tag alone, for a failure whose text may carry paths or output. */
export const tagOf = (cause: unknown): string => {
  const tag = typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag : cause instanceof Error ? cause.name : "Unknown";
  return tagPattern.test(tag) ? tag : "Unknown";
};
