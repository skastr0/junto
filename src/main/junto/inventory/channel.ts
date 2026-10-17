/**
 * The answering end of the link's inventory channel. The peer names a canvas
 * and nothing else; this machine admits it as it admits Stop (the peer is
 * pinned, edits that canvas, and the canvas has a seat here), then answers
 * from its own cache. A request never runs a probe: a stale or missing list
 * answers with `refreshing` and is scanned behind the answer, so the 30 s
 * request bound is never at stake.
 */
import { Effect, Schema } from "effect";
import { isThisMachine } from "@shared/machine-name";
import type { LinkChannelHandler } from "../link/types";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { InventoryUnavailableError } from "@shared/harness-domain/inventory";
import { HarnessInventory } from "../term/templates/harness-inventory";
import {
  InventoryCanvasEditorMismatch,
  InventoryLinkFailure,
  InventoryNoSeatHere,
  InventoryPeerNotPinned,
  LinkInventoryRequest,
  type InventoryLinkFailure as InventoryLinkFailureType,
  wireSnapshot,
} from "./wire";

const isLinkFailure = Schema.is(InventoryLinkFailure);

/**
 * Keep a channel failure as it is; anything else crosses as unavailable with
 * its tag only, since its text can carry paths or command output.
 */
const asLinkFailure = (machine: string, cause: unknown): InventoryLinkFailureType => {
  if (isLinkFailure(cause)) return cause;
  const tag = typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag : cause instanceof Error ? cause.name : "Unknown";
  return new InventoryUnavailableError({ machine, reason: "failed", message: `This machine could not answer (${tag.slice(0, 64)}).` });
};

/** A channel with no events refuses every event frame. */
const noEvents = (): never => {
  throw new Error("the inventory channel carries no events");
};

export const makeInventoryChannel = Effect.fn("InventoryLink.make")(function* () {
  const model = yield* ModelService;
  const records = yield* ModelRecords;
  const machines = yield* MachineRepository;
  const inventory = yield* HarnessInventory;

  const handleRequest: NonNullable<LinkChannelHandler["handleRequest"]> = (context, raw) => Effect.gen(function* () {
    // Decode here too: direct callers cannot bypass the transport decoder.
    const request = yield* Schema.decodeUnknownEffect(LinkInventoryRequest)(raw, { onExcessProperty: "error" });
    const machine = yield* machines.machineName;
    const where = {
      machine,
      ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    };
    // Identity comes from the admitted hello, never from the payload.
    const peer = yield* machines.peer(context.peer.machineName);
    if (peer?.installationId !== context.peer.installationId)
      return yield* new InventoryPeerNotPinned({ ...where, message: "The asking machine is no longer pinned." });
    if ((yield* records.canvasEditor(request.canvas)) !== context.peer.installationId)
      return yield* new InventoryCanvasEditorMismatch({
        ...where,
        message: "Only the machine editing this canvas may ask for its seats' machine inventory.",
      });
    const canvas = yield* model.canvas(request.canvas);
    const seatHere = [...canvas.nodes.values()].some((node) => node.kind === "agent" && isThisMachine(node.host, machine));
    if (!seatHere) return yield* new InventoryNoSeatHere({ ...where, message: "This canvas has no seat on this machine." });
    const { snapshot, omittedModels } = wireSnapshot(yield* inventory.machine, Date.now());
    if (omittedModels > 0) yield* Effect.logInfo("inventory models left out", { omittedModels });
    return snapshot;
  }).pipe(
    Effect.tapCause((cause) => Effect.logError("inventory failed", cause)),
    Effect.catch((cause) => machines.machineName.pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((machine) => Effect.fail(asLinkFailure(machine, cause))),
    )),
    Effect.tap(() => Effect.logInfo("inventory answered")),
    Effect.annotateLogs({
      area: "inventory",
      peer: context.peer.machineName,
      ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    }),
  );

  const handler: LinkChannelHandler = {
    failureSchema: InventoryLinkFailure as Schema.Codec<unknown, unknown>,
    decodeRequest: Schema.decodeUnknownSync(LinkInventoryRequest, { onExcessProperty: "error" }),
    // A response that throws here would close the whole link as frame-invalid,
    // so the requester decodes the snapshot itself, after the request returns,
    // and refuses a bad one with the link open.
    decodeResponse: (payload) => payload,
    decodeEvent: noEvents,
    handleRequest,
  };
  return handler;
});
