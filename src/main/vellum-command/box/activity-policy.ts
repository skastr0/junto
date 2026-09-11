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
 * The contribution of a canvas whose current content is unknown to this pass
 * — never read, or a read that failed with nothing cached behind it. It is the
 * same verdict the derivation already reaches for work it cannot place: keep
 * every owned Box awake rather than authorize a sleep on missing evidence.
 */
const UNKNOWN_CANVAS_ACTIVITY: BoxHostActivity = {
  activeHostIds: new Set<string>(),
  hasUnresolvedActiveWork: true,
};

/**
 * `BoxHostActivity` is a monoid over canvases: host ids union, the unresolved
 * flag ORs, and the empty canvas is the identity. That is the whole licence
 * for caching one contribution per canvas and re-merging, instead of
 * re-deriving the portfolio from every document on every commit.
 */
export const mergeBoxHostActivity = (
  parts: Iterable<BoxHostActivity>,
): BoxHostActivity => {
  const activeHostIds = new Set<string>();
  let hasUnresolvedActiveWork = false;
  for (const part of parts) {
    for (const hostId of part.activeHostIds) activeHostIds.add(hostId);
    if (part.hasUnresolvedActiveWork) hasUnresolvedActiveWork = true;
  }
  return { activeHostIds, hasUnresolvedActiveWork };
};

/**
 * Everything the reconciler reads or writes, as plain effects. The layer binds
 * the real services; a test binds fakes and can then count reads, which is the
 * only way to assert that one canvas commit costs one canvas read.
 */
export interface BoxActivitySource {
  readonly stationRole: Effect.Effect<string, unknown>;
  readonly listCanvasNames: Effect.Effect<ReadonlyArray<string>, unknown>;
  readonly readCanvas: (
    name: string,
  ) => Effect.Effect<CanvasReadResult, unknown>;
  readonly listBoxes: Effect.Effect<ReadonlyArray<BoxResource>, unknown>;
  readonly setActivityDemand: (
    boxId: string,
    demanded: boolean,
  ) => Effect.Effect<unknown, unknown>;
}

export interface BoxActivityReconciler {
  /**
   * Mark one canvas stale, or — with no name — the whole portfolio. Recording
   * the name is all this does; the caller wakes the reconcile loop.
   */
  readonly invalidate: (canvasName?: string) => void;
  /** One pass over whatever is currently stale. Never fails. */
  readonly reconcile: Effect.Effect<void>;
}

/**
 * Dirty-set invalidation over an incrementally maintained view.
 *
 * The old shape re-read every canvas in the portfolio on every commit to any
 * canvas, because the change listener discarded the name it was handed. Cost
 * scaled with the portfolio, not with the edit. `kernel/service.ts` already
 * keys the same canvas-change stream by name (`resyncCanvas`, and the
 * per-canvas immediate lane above it); this follows it.
 *
 * Why a set of names and not a queue of names: the wake-up channel is
 * `Queue.dropping(1)`, which drops on a full queue by design — dropping a
 * redundant *token* is free, dropping a canvas *name* would silently forget
 * that canvas. Names accumulate in a set that only the reconcile pass drains,
 * so a burst on one canvas collapses to one read and a burst across canvases
 * collapses to one pass covering all of them.
 */
export const makeBoxActivityReconciler = (
  source: BoxActivitySource,
): Effect.Effect<BoxActivityReconciler> =>
  Effect.gen(function* () {
    const reconcileLock = yield* Semaphore.make(1);
    const appliedDemand = new Map<string, boolean>();
    // The maintained view: one derived contribution per canvas.
    const contributions = new Map<string, BoxHostActivity>();
    const staleCanvases = new Set<string>();
    let sweepPending = true;

    const invalidate = (canvasName?: string): void => {
      if (canvasName === undefined) sweepPending = true;
      else staleCanvases.add(canvasName);
    };

    const reconcile = reconcileLock.withPermits(1)(
      Effect.gen(function* () {
        // Claim the stale set before the first yield. Anything invalidated
        // while this pass runs lands in the next set, and arrived with its own
        // wake-up token, so it gets its own pass instead of being lost here.
        const sweep = sweepPending;
        const stale = new Set(staleCanvases);
        sweepPending = false;
        staleCanvases.clear();

        const role = yield* source.stationRole;
        if (role !== "command-center") {
          appliedDemand.clear();
          contributions.clear();
          // The role can come back without any canvas committing, so the next
          // pass under command-center has to rebuild from the whole portfolio.
          sweepPending = true;
          return;
        }

        const [names, resources] = yield* Effect.all([
          source.listCanvasNames,
          source.listBoxes,
        ]);
        const present = new Set(names);
        for (const name of contributions.keys()) {
          if (!present.has(name)) contributions.delete(name);
        }

        // Read exactly the canvases whose contribution is stale: the named
        // ones, plus any canvas with nothing cached yet (created, or a read
        // that failed on an earlier pass). A sweep asks for all of them.
        const targets = names.filter(
          (name) => sweep || stale.has(name) || !contributions.has(name),
        );
        yield* Effect.forEach(
          targets,
          (name) =>
            Effect.result(source.readCanvas(name)).pipe(
              Effect.map((result) => {
                if (result._tag === "Success") {
                  contributions.set(
                    name,
                    deriveBoxHostActivity([result.success]),
                  );
                }
                // A failed read keeps the previous contribution. With none, the
                // canvas stays uncached and the merge below falls back to
                // "unknown", which keeps Boxes awake instead of sleeping one
                // that may be carrying live work.
              }),
            ),
          { concurrency: 4, discard: true },
        );

        const activity = mergeBoxHostActivity(
          names.some((name) => !contributions.has(name))
            ? [...contributions.values(), UNKNOWN_CANVAS_ACTIVITY]
            : contributions.values(),
        );
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
            return source
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

    return { invalidate, reconcile };
  });

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/box/BoxActivityPolicy` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class BoxActivityPolicy extends Context.Service<BoxActivityPolicy, BoxActivityPolicy>()("@vellum-command/box/BoxActivityPolicy") {}`
 * - Layer today: BoxActivityPolicyLive — V4 rename candidate BoxActivityPolicy.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class BoxActivityPolicy extends Context.Service<BoxActivityPolicy,
  {
    /**
     * Coalesced reconciliation after work, routing, or Box lifecycle changes.
     * With a canvas name, only that canvas is re-read. Without one — Box
     * lifecycle, startup — the next pass sweeps the whole portfolio.
     */
    readonly request: (canvasName?: string) => void;
    /** Interaction gate for a possibly provider-stopped Vellum Command-owned host. */
    readonly ensureHostAvailable: (
      hostId: string,
    ) => Effect.Effect<void, BoxFleetError>;
  }>()("@vellum-command/box/BoxActivityPolicy") {}

export const BoxActivityPolicyLive = Layer.effect(
  BoxActivityPolicy,
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const settings = yield* SettingsService;
    const fleet = yield* BoxFleetService;
    const invalidations = yield* Queue.dropping<void>(1);

    const reconciler = yield* makeBoxActivityReconciler({
      stationRole: Effect.map(
        settings.get,
        (configuration) => configuration.station.role,
      ),
      listCanvasNames: Effect.map(canvases.list, (summaries) =>
        summaries.map((summary) => summary.name),
      ),
      readCanvas: (name) => canvases.read(name, "box.activityPolicy"),
      listBoxes: fleet.list,
      setActivityDemand: (boxId, demanded) =>
        fleet.setActivityDemand(boxId, demanded),
    });

    const coordinator = Effect.forever(
      Queue.take(invalidations).pipe(Effect.andThen(reconciler.reconcile)),
    );
    yield* Effect.forkScoped(coordinator);

    let admissionClosed = false;
    const request = (canvasName?: string): void => {
      if (admissionClosed) return;
      reconciler.invalidate(canvasName);
      Queue.offerUnsafe(invalidations, undefined);
    };
    // CanvasesService merges committed Work changes into this invalidation
    // stream, so claims and terminal transitions need no second subscription.
    // The name is the whole point: it scopes the next pass to one canvas.
    const unsubscribe = canvases.subscribeChanges((name) => request(name));
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
          Effect.tap(() => Effect.sync(() => request())),
          Effect.asVoid,
        ),
    });
  }),
);
