/**
 * The asking end of the link's inventory channel. The machine that edits a
 * canvas asks a seat's machine for its snapshot, naming the canvas only. The
 * answer is decoded closed here, after the request returns, so a bad snapshot
 * is one typed refusal with the link still open. A good one is kept on disk;
 * when the machine cannot be asked, the last one it sent answers with its age
 * and the typed reason.
 */
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { InventoryUnavailableError } from "@shared/harness-domain/inventory";
import type { MachineInventoryResult } from "@shared/ipc";
import { isThisMachine } from "@shared/machine-name";
import { describeCause } from "../failure-encode";
import { HostsService } from "../hosts/service";
import { MachineLink } from "../link/service";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { makePeerInventoryCache, type PeerInventoryCache, type StoredPeerInventory } from "./peer-cache";
import {
  decodeLinkInventorySnapshot,
  InventoryLinkFailure,
  InventoryNotFromItsMachine,
  InventorySnapshotRefused,
  inventoryOfSnapshot,
} from "./wire";

/** A decode failure as its issue kind and path; any other text through the doctrine scrub. */
const reasonOf = (cause: unknown): string => describeCause(cause).message.slice(0, 500);

const tagOf = (cause: unknown): string =>
  (typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag : cause instanceof Error ? cause.name : "Unknown").slice(0, 64);

const isLinkFailure = Schema.is(InventoryLinkFailure);

/** The answering machine's own typed refusal, when the link carried one. */
const unwrap = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "detail" in cause && isLinkFailure(cause.detail) ? cause.detail : cause;

/** The machine could not be asked, or its answer was not taken; the link's own errors read unreachable. */
const reasonFor = (cause: unknown): "timeout" | "failed" | "unreachable" | "notInstalled" => {
  if (cause instanceof InventoryUnavailableError) return cause.reason;
  if (cause instanceof InventorySnapshotRefused || cause instanceof InventoryNotFromItsMachine || isLinkFailure(cause)) return "failed";
  return "unreachable";
};

export const makePeerInventoryClient = (cache: PeerInventoryCache) => {
  /** A canvas this machine edits with a seat on that machine: the only thing a request names. */
  const canvasFor = (machine: string) => Effect.gen(function* () {
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

  const ask = (machine: string, operationId: string) => Effect.gen(function* () {
    const canvas = yield* canvasFor(machine);
    if (canvas === undefined)
      return yield* new InventoryUnavailableError({
        machine,
        reason: "unreachable",
        message: `No canvas this machine edits has a seat on ${machine}, so it cannot ask ${machine} for its harnesses.`,
      });
    const host = yield* (yield* HostsService).get(machine);
    if (host === undefined)
      return yield* new InventoryUnavailableError({ machine, reason: "unreachable", message: `${machine} is not a registered machine.` });
    const link = yield* MachineLink;
    yield* link.connect(host);
    const payload = yield* link.request(machine, "inventory", { canvas }, { operationId });
    const snapshot = yield* Effect.try({
      try: () => decodeLinkInventorySnapshot(payload),
      catch: (cause) => new InventorySnapshotRefused({
        machine,
        operationId,
        message: `${machine} sent an inventory this machine does not accept: ${reasonOf(cause)}`,
      }),
    });
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

  /** That machine's snapshot, or why it cannot be read now with the last one it sent. */
  const inventoryOf = (machine: string, operationId: string = randomUUID()) =>
    ask(machine, operationId).pipe(
      Effect.map((inventory): MachineInventoryResult => ({ ok: true, inventory })),
      Effect.catch((raw: unknown) => Effect.gen(function* () {
        const cause = unwrap(raw);
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

  return { inventoryOf };
};

export type PeerInventoryClient = ReturnType<typeof makePeerInventoryClient>;

let shared: PeerInventoryClient | undefined;
/** This process's client over the default peer-inventory directory. */
export const peerInventory = (): PeerInventoryClient => (shared ??= makePeerInventoryClient(makePeerInventoryCache()));
