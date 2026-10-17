/**
 * The answering end of the link's inventory channel. The peer names a canvas
 * and nothing else; this machine admits it as it admits Stop (the peer is
 * pinned, edits that canvas, and the canvas has a seat here), then answers
 * from its own cache. A request never runs a probe: a stale or missing list
 * answers with `refreshing` and is scanned behind the answer, so the 30 s
 * request bound is never at stake.
 */
import { Effect, Schema } from "effect";
import type { LinkChannelHandler } from "../link/types";
import { logMachine } from "../observability/logger";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { InventoryUnavailableError } from "@shared/harness-domain/inventory";
import { HarnessInventory } from "../term/templates/harness-inventory";
import { admitCanvasEditor, tagOf } from "./admission";
import {
  InventoryEventRefused,
  InventoryLinkFailure,
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
  return new InventoryUnavailableError({ machine, reason: "failed", message: `This machine could not answer (${tagOf(cause)}).` });
};

/** A channel with no events refuses every event frame. */
const noEvents = (): never => {
  throw new InventoryEventRefused({ message: "The inventory channel carries no events." });
};

export const makeInventoryChannel = Effect.fn("InventoryLink.make")(function* () {
  const services = yield* Effect.context<ModelService | ModelRecords | MachineRepository>();
  const machines = yield* MachineRepository;
  const inventory = yield* HarnessInventory;

  const handleRequest: NonNullable<LinkChannelHandler["handleRequest"]> = (context, raw) => Effect.gen(function* () {
    // Decode here too: direct callers cannot bypass the transport decoder.
    const request = yield* Schema.decodeUnknownEffect(LinkInventoryRequest)(raw, { onExcessProperty: "error" });
    yield* admitCanvasEditor(context, request.canvas, yield* machines.machineName).pipe(Effect.provideContext(services));
    const { snapshot, omittedModels, omittedProfiles } = wireSnapshot(yield* inventory.machine, Date.now());
    if (omittedModels > 0 || omittedProfiles > 0) yield* Effect.logInfo("inventory entries left out", { omittedModels, omittedProfiles });
    return snapshot;
  }).pipe(
    Effect.tapCause((cause) => Effect.logError("inventory failed", cause)),
    Effect.catch((cause) => machines.machineName.pipe(
      // The name the machine log already carries, when this machine's own cannot be read.
      Effect.orElseSucceed(logMachine),
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
