/**
 * The answering end of the link's inventory channel. The peer's pin and the
 * open link are the whole admission: the request names nothing, and this
 * machine answers from its own cache. Asks coalesce per machine: one snapshot
 * in flight, none while the cache is fresh, whoever asks and however often. A
 * request never runs a probe it waits on: a stale or missing list answers
 * with `refreshing` and is scanned behind the answer, so the 30 s request
 * bound is never at stake.
 */
import { Deferred, Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { bindLinkChannel, linkContract, type LinkContractChannel } from "../link/contract";
import type { LinkChannelContext } from "../link/types";
import { LogService } from "../../node/observability/logger";
import { MachineRepository } from "../machines/repository";
import { InventoryUnavailableError, type MachineInventory } from "@shared/harness-domain/inventory";
import { HarnessInventory } from "../term/templates/harness-inventory";
import { admitPinnedPeer, tagOf } from "./admission";
import {
  InventoryLinkFailure,
  LinkInventoryRequest,
  LinkInventorySnapshot,
  type InventoryLinkFailure as InventoryLinkFailureType,
  wireSnapshot,
} from "./wire";

/**
 * The inventory channel's contract: one request that names nothing, answered
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
  const services = yield* Effect.context<MachineRepository>();
  const machines = yield* MachineRepository;
  const inventory = yield* HarnessInventory;

  // One machine snapshot in flight, shared by every asker: while a peer waits
  // on it no second one starts, and a fresh cache starts no scan at all.
  let answering: Deferred.Deferred<MachineInventory, InventoryUnavailableError> | undefined;
  const machineSnapshot = Effect.gen(function* () {
    const running = answering;
    if (running !== undefined) return yield* Deferred.await(running);
    const done = Deferred.makeUnsafe<MachineInventory, InventoryUnavailableError>();
    answering = done;
    return yield* inventory.machine.pipe(
      Effect.onExit((exit) => {
        if (answering === done) answering = undefined;
        return Deferred.done(done, exit);
      }),
    );
  });

  const snapshot = (_request: LinkInventoryRequest, context: LinkChannelContext) => Effect.gen(function* () {
    yield* admitPinnedPeer(context, yield* machines.machineName).pipe(Effect.provideContext(services));
    const { snapshot, omittedModels, omittedProfiles } = wireSnapshot(yield* machineSnapshot, Date.now());
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
