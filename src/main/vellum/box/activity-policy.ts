import { Context, Effect, Layer, Queue, Semaphore } from "effect";
import type { Task } from "@shared/canvas";
import type { CanvasReadResult } from "@shared/ipc";
import { resolveNodePlacement } from "@shared/physics";
import { CanvasesService } from "../canvases";
import { SettingsService } from "../settings/service";
import { boxHostId, type BoxResource } from "./repository";
import { BoxFleetService, type BoxFleetError } from "./service";

const machineCanReceiveLease = (resource: BoxResource): boolean =>
  resource.machine.state === "ready" ||
  resource.machine.state === "idle" ||
  resource.machine.state === "running";

const isActiveWork = (item: Task): boolean =>
  item.state === "working" ||
  item.state === "input-required" ||
  item.state === "auth-required";

export interface BoxHostActivity {
  readonly activeHostIds: ReadonlySet<string>;
  /**
   * Active work without an exact compiled actor/placement cannot safely
   * authorize a provider sleep decision. Callers keep owned Boxes awake until
   * the projection becomes coherent.
   */
  readonly hasUnresolvedActiveWork: boolean;
}

/**
 * Derive provider demand from Vellum Command's canonical work truth.
 *
 * Placement is only routing intent. A Box is active when an actor placed on it
 * owns an item whose claim has already started work. Submitted and terminal
 * items do not pin a machine.
 */
export const deriveBoxHostActivity = (
  reads: Iterable<CanvasReadResult>,
): BoxHostActivity => {
  const activeHostIds = new Set<string>();
  let hasUnresolvedActiveWork = false;

  for (const read of reads) {
    const actorBySeat = new Map(
      read.actorRefs.map((actor) => [actor.seatId, actor]),
    );
    const nodeById = new Map(read.doc.nodes.map((node) => [node.id, node]));

    for (const node of read.doc.nodes) {
      const items = [
        ...(node.ether?.tasks?.items ?? []),
        ...(node.ether?.requests?.items ?? []),
      ];
      for (const item of items) {
        if (!isActiveWork(item)) continue;
        const actor =
          item.claimedBy === undefined
            ? undefined
            : actorBySeat.get(item.claimedBy);
        const actorNode =
          actor === undefined ? undefined : nodeById.get(actor.nodeId);
        const hostId =
          actorNode === undefined
            ? undefined
            : resolveNodePlacement(actorNode).assignment;
        if (hostId === undefined) {
          hasUnresolvedActiveWork = true;
        } else {
          activeHostIds.add(hostId);
        }
      }
    }
  }

  return { activeHostIds, hasUnresolvedActiveWork };
};

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/box/BoxActivityPolicy` — single definition; no dual path.
 * - Substrate: effect@3.21 → `Context.Tag` (`Context.Service` unavailable).
 * - V4 target:
 *   `class BoxActivityPolicy extends Context.Service<BoxActivityPolicy, BoxActivityPolicy>()("@vellum/box/BoxActivityPolicy") {}`
 * - Layer today: BoxActivityPolicyLive — V4 rename candidate BoxActivityPolicy.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class BoxActivityPolicy extends Context.Service<BoxActivityPolicy,
  {
    /** Coalesced reconciliation after work, routing, or Box lifecycle changes. */
    readonly request: () => void;
    /** Interaction gate for a possibly provider-stopped Vellum Command-owned host. */
    readonly ensureHostAvailable: (
      hostId: string,
    ) => Effect.Effect<void, BoxFleetError>;
  }>()("@vellum/box/BoxActivityPolicy") {}

export const BoxActivityPolicyLive = Layer.effect(
  BoxActivityPolicy,
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const settings = yield* SettingsService;
    const fleet = yield* BoxFleetService;
    const invalidations = yield* Queue.dropping<void>(1);
    const reconcileLock = yield* Semaphore.make(1);
    const appliedDemand = new Map<string, boolean>();

    const reconcile = reconcileLock.withPermits(1)(
      Effect.gen(function* () {
        const configuration = yield* settings.get;
        if (configuration.station.role !== "command-center") {
          appliedDemand.clear();
          return;
        }

        const [summaries, resources] = yield* Effect.all([
          canvases.list,
          fleet.list,
        ]);
        const reads = yield* Effect.forEach(
          summaries,
          (summary) => canvases.read(summary.name),
          { concurrency: 4 },
        );
        const activity = deriveBoxHostActivity(reads);
        const visible = new Set<string>(
          resources.map((resource) => resource.machine.id),
        );
        for (const boxId of appliedDemand.keys()) {
          if (!visible.has(boxId)) appliedDemand.delete(boxId);
        }

        yield* Effect.forEach(
          resources,
          (resource) => {
            if (!machineCanReceiveLease(resource)) {
              appliedDemand.delete(resource.machine.id);
              return Effect.void;
            }
            const demanded =
              activity.hasUnresolvedActiveWork ||
              activity.activeHostIds.has(boxHostId(resource.machine.id));
            if (appliedDemand.get(resource.machine.id) === demanded) {
              return Effect.void;
            }
            return fleet
              .setActivityDemand(resource.machine.id, demanded)
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    appliedDemand.set(resource.machine.id, demanded);
                  }),
                ),
                Effect.catch((error) =>
                  Effect.logWarning(
                    `Box activity lease reconciliation failed for ${resource.machine.id}`,
                    error,
                  ),
                ),
                Effect.asVoid,
              );
          },
          { concurrency: 1, discard: true },
        );
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Box activity lease reconciliation failed", error),
      ),
    );

    const coordinator = Effect.forever(
      Queue.take(invalidations).pipe(Effect.andThen(reconcile)),
    );
    yield* Effect.forkScoped(coordinator);

    let admissionClosed = false;
    const request = (): void => {
      if (!admissionClosed) Queue.offerUnsafe(invalidations, undefined);
    };
    // CanvasesService merges committed Work changes into this invalidation
    // stream, so claims and terminal transitions need no second subscription.
    const unsubscribe = canvases.subscribeChanges(request);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        admissionClosed = true;
        unsubscribe();
      }),
    );

    request();

    return BoxActivityPolicy.of({
      request,
      ensureHostAvailable: (hostId) =>
        fleet.ensureHostAvailable(hostId).pipe(
          Effect.tap(() => Effect.sync(request)),
          Effect.asVoid,
        ),
    });
  }),
);
