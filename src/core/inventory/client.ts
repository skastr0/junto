/**
 * The asking end of the link's inventory channel. The machine that edits a
 * canvas asks a seat's machine for its snapshot, naming the canvas only, with
 * the channel's typed client. The session decodes the answer closed with the
 * contract's schema, and a bad snapshot fails only that request, so it is one
 * typed refusal with the link still open. A good one is kept on disk; when
 * the machine cannot be asked, the last one it sent answers with its age and
 * the typed reason.
 */
import { randomUUID } from "node:crypto";
import { Context, Effect, Layer } from "effect";
import { InventoryUnavailableError } from "@shared/harness-domain/inventory";
import type { MachineInventoryResult } from "@shared/ipc";
import { describeCause } from "../../node/failure-encode";
import { HostsService } from "../hosts/service";
import { linkClient } from "../link/contract";
import { isMachineLinkError, MachineLink } from "../link/service";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { canvasWithSeatOn, tagOf } from "./admission";
import { InventoryLink } from "./channel";
import { makePeerInventoryCache, type PeerInventoryCache, type StoredPeerInventory } from "./peer-cache";
import { InventoryNotFromItsMachine, InventorySnapshotRefused, inventoryOfSnapshot } from "./wire";

/** A decode failure as its issue kind and path; any other text through the doctrine scrub. */
const reasonOf = (cause: unknown): string => describeCause(cause).message.slice(0, 500);

/** The machine could not be asked, or its answer was not taken; the link's own errors read unreachable. */
const reasonFor = (cause: unknown): "timeout" | "failed" | "unreachable" | "notInstalled" => {
  if (cause instanceof InventoryUnavailableError) return cause.reason;
  return isMachineLinkError(cause) ? "unreachable" : "failed";
};

export class PeerInventory extends Context.Service<PeerInventory, {
  /** That machine's snapshot, or why it cannot be read now with the last one it sent. */
  readonly inventoryOf: (machine: string, operationId?: string) => Effect.Effect<MachineInventoryResult>;
}>()("@junto/PeerInventory") {}

export const makePeerInventory = Effect.fn("PeerInventory.make")(function* (cache: PeerInventoryCache) {
  const inventory = yield* linkClient(InventoryLink);
  const link = yield* MachineLink;
  const hosts = yield* HostsService;
  const lookups = yield* Effect.context<ModelService | ModelRecords | MachineRepository>();

  const ask = (machine: string, operationId: string) => Effect.gen(function* () {
    const canvas = yield* canvasWithSeatOn(machine).pipe(Effect.provideContext(lookups));
    if (canvas === undefined)
      return yield* new InventoryUnavailableError({
        machine,
        reason: "unreachable",
        message: `No canvas this machine edits has a seat on ${machine}, so it cannot ask ${machine} for its harnesses.`,
      });
    const host = yield* hosts.get(machine);
    if (host === undefined)
      return yield* new InventoryUnavailableError({ machine, reason: "unreachable", message: `${machine} is not a registered machine.` });
    yield* link.connect(host);
    const snapshot = yield* inventory.Snapshot(machine, { canvas }, { operationId }).pipe(
      Effect.catchTag("LinkFrameInvalid", (refused) => Effect.fail(refused.problem !== "response" ? refused : new InventorySnapshotRefused({
        machine,
        operationId,
        message: `${machine} sent an inventory this machine does not accept: ${reasonOf(refused)}`,
      }))),
    );
    // The peer the link admitted is the only machine a snapshot may describe.
    if (snapshot.machine !== machine)
      return yield* new InventoryNotFromItsMachine({
        machine,
        claimed: snapshot.machine,
        operationId,
        message: `${machine} sent an inventory that names another machine.`,
      });
    yield* cache.write(machine, { snapshot, receivedAt: Date.now() }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("peer inventory not stored", cause)),
    );
    return inventoryOfSnapshot(snapshot);
  });

  const lastOf = (machine: string) =>
    cache.read(machine).pipe(
      Effect.map((stored: StoredPeerInventory | undefined) =>
        stored === undefined ? undefined : { inventory: inventoryOfSnapshot(stored.snapshot), receivedAt: stored.receivedAt }),
      Effect.catchCause((cause) => Effect.logWarning("stored peer inventory refused", cause).pipe(Effect.as(undefined))),
    );

  const inventoryOf = (machine: string, operationId: string = randomUUID()) =>
    ask(machine, operationId).pipe(
      Effect.map((inventory): MachineInventoryResult => ({ ok: true, inventory })),
      Effect.catch((cause) => Effect.gen(function* () {
        const failure = tagOf(cause);
        const reason = reasonFor(cause);
        yield* Effect.logWarning("peer inventory failed", { failure, reason }, cause);
        const last = yield* lastOf(machine);
        const message = reason === "unreachable" && !(cause instanceof InventoryUnavailableError)
          ? `${machine} could not be asked for its harnesses: ${reasonOf(cause)}`
          : reasonOf(cause);
        return {
          ok: false,
          error: {
            _tag: "InventoryUnavailableError",
            machine,
            reason,
            message,
            failure,
            operationId,
            ...(last === undefined ? {} : { last }),
          },
        } satisfies MachineInventoryResult;
      })),
      Effect.annotateLogs({ area: "inventory", peer: machine, operationId }),
    );

  return PeerInventory.of({ inventoryOf });
});

/** This core's client over the peer-inventory directory under its home, or `dir`. */
export const peerInventoryLayer = (dir?: string) =>
  Layer.effect(PeerInventory, Effect.suspend(() => makePeerInventory(makePeerInventoryCache(dir))));

/**
 * @deprecated Until `ops/term-ipc.ts` yields `PeerInventory` and the core
 * runtime provides `peerInventoryLayer()`. Builds the client per call from
 * the caller's context; it holds no module state.
 */
export const peerInventory = () => ({
  inventoryOf: (machine: string, operationId?: string) =>
    Effect.flatMap(makePeerInventory(makePeerInventoryCache()), (client) => client.inventoryOf(machine, operationId)),
});
