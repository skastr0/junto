import { Context, Effect, Layer, Queue } from "effect";
import type { CanvasDoc } from "@shared/canvas";
import { resolveNodePlacement } from "@shared/physics";
import { CanvasesService } from "../canvases";
import { SettingsService } from "../settings/service";
import { boxHostId, type BoxResource } from "./repository";
import { BoxFleetService, type BoxFleetError } from "./service";

const machineCanReceiveLease = (resource: BoxResource): boolean =>
  resource.machine.state === "ready" ||
  resource.machine.state === "idle" ||
  resource.machine.state === "running";

export const placedHostIds = (
  documents: Iterable<CanvasDoc>,
): ReadonlySet<string> => {
  const placed = new Set<string>();
  for (const document of documents) {
    for (const node of document.nodes) {
      const placement = resolveNodePlacement(node);
      if (placement.assignment !== undefined) {
        placed.add(placement.assignment);
      }
    }
  }
  return placed;
};

export class BoxPlacementPolicy extends Context.Tag(
  "@vellum/box/BoxPlacementPolicy",
)<
  BoxPlacementPolicy,
  {
    /** Coalesced reconciliation after authorial placement or Box lifecycle. */
    readonly request: () => void;
    /** Interaction gate for a possibly provider-stopped Vellum-owned host. */
    readonly ensureHostAvailable: (
      hostId: string,
    ) => Effect.Effect<void, BoxFleetError>;
  }
>() {}

export const BoxPlacementPolicyLive = Layer.scoped(
  BoxPlacementPolicy,
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const settings = yield* SettingsService;
    const fleet = yield* BoxFleetService;
    const invalidations = yield* Queue.dropping<void>(1);
    const reconcileLock = yield* Effect.makeSemaphore(1);
    const appliedDemand = new Map<string, boolean>();

    const reconcile = reconcileLock.withPermits(1)(
      Effect.gen(function* () {
        const configuration = yield* settings.get;
        if (configuration.station.role !== "command-center") {
          appliedDemand.clear();
          return;
        }

        const [authority, resources] = yield* Effect.all([
          canvases.authoritySnapshot(),
          fleet.list,
        ]);
        const demand = placedHostIds(authority.documents.values());
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
            const demanded = demand.has(boxHostId(resource.machine.id));
            if (appliedDemand.get(resource.machine.id) === demanded) {
              return Effect.void;
            }
            return fleet
              .setPlacementDemand(resource.machine.id, demanded)
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    appliedDemand.set(resource.machine.id, demanded);
                  }),
                ),
                Effect.catchAll((error) =>
                  Effect.logWarning(
                    `Box placement lease reconciliation failed for ${resource.machine.id}`,
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
      Effect.catchAll((error) =>
        Effect.logWarning("Box placement lease reconciliation failed", error),
      ),
    );

    const coordinator = Effect.forever(
      invalidations.take.pipe(Effect.andThen(reconcile)),
    );
    yield* Effect.forkScoped(coordinator);

    let admissionClosed = false;
    const request = (): void => {
      if (!admissionClosed) invalidations.unsafeOffer(undefined);
    };
    const unsubscribe = canvases.subscribeChanges(request);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        admissionClosed = true;
        unsubscribe();
      }),
    );

    request();

    return BoxPlacementPolicy.of({
      request,
      ensureHostAvailable: (hostId) =>
        fleet.ensureHostAvailable(hostId).pipe(
          Effect.tap(() => Effect.sync(request)),
          Effect.asVoid,
        ),
    });
  }),
);
