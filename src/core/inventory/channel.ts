/**
 * The answering end of the link's inventory channel. The peer names a canvas
 * and nothing else; this machine admits it as it admits Stop (the peer is
 * pinned, edits that canvas, and the canvas has a seat here), then answers
 * from its own cache. A request never runs a probe: a stale or missing list
 * answers with `refreshing` and is scanned behind the answer, so the 30 s
 * request bound is never at stake.
 */
import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { bindLinkChannel, linkContract, type LinkContractChannel } from "../link/contract";
import type { LinkChannelContext } from "../link/types";
import { LogService } from "../../node/observability/logger";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { InventoryUnavailableError } from "@shared/harness-domain/inventory";
import { HarnessInventory } from "../term/templates/harness-inventory";
import { admitCanvasEditor, tagOf } from "./admission";
import {
  InventoryLinkFailure,
  LinkInventoryRequest,
  LinkInventorySnapshot,
  type InventoryLinkFailure as InventoryLinkFailureType,
  wireSnapshot,
} from "./wire";

/**
 * The inventory channel's contract: one request, the canvas only, answered
 * with the machine's bounded snapshot or one of the channel's closed
 * refusals. It carries no events.
 */
export const InventoryLink = linkContract("inventory", RpcGroup.make(
  Rpc.make("Snapshot", { payload: LinkInventoryRequest, success: LinkInventorySnapshot, error: InventoryLinkFailure }),
));

const isLinkFailure = Schema.is(InventoryLinkFailure);

/**
 * Keep a channel failure as it is; anything else crosses as unavailable with
 * its tag only, since its text can carry paths or command output.
 */
const asLinkFailure = (machine: string, cause: unknown): InventoryLinkFailureType => {
  if (isLinkFailure(cause)) return cause;
  return new InventoryUnavailableError({ machine, reason: "failed", message: `This machine could not answer (${tagOf(cause)}).` });
};

export const makeInventoryChannel = Effect.fn("InventoryLink.make")(function* () {
  const log = yield* LogService;
  const services = yield* Effect.context<ModelService | ModelRecords | MachineRepository>();
  const machines = yield* MachineRepository;
  const inventory = yield* HarnessInventory;

  const snapshot = (request: LinkInventoryRequest, context: LinkChannelContext) => Effect.gen(function* () {
    yield* admitCanvasEditor(context, request.canvas, yield* machines.machineName).pipe(Effect.provideContext(services));
    const { snapshot, omittedModels, omittedProfiles } = wireSnapshot(yield* inventory.machine, Date.now());
    if (omittedModels > 0 || omittedProfiles > 0) yield* Effect.logInfo("inventory entries left out", { omittedModels, omittedProfiles });
    return snapshot;
  }).pipe(
    Effect.tapCause((cause) => Effect.logError("inventory failed", cause)),
    Effect.catch((cause) => machines.machineName.pipe(
      // The name the machine log already carries, when this machine's own cannot be read.
      Effect.orElseSucceed(() => log.machine()),
      Effect.flatMap((machine) => Effect.fail(asLinkFailure(machine, cause))),
    )),
    Effect.tap(() => Effect.logInfo("inventory answered")),
    Effect.annotateLogs({
      area: "inventory",
      peer: context.peer.machineName,
      ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    }),
  );

  const channel: LinkContractChannel = bindLinkChannel(InventoryLink, { requests: { Snapshot: snapshot } });
  return channel;
});
