/**
 * The in-memory factory world.
 *
 * THE OPERATOR INVARIANT: the factory world is an in-memory, event-sourced
 * simulation; SQLite is the append-only journal, never the read path.
 *
 * What this module holds is the READ MODEL half of that invariant. Every
 * sink's snapshot stays resident, and a canvas read serves the resident
 * snapshots. The cost that made a working factory crawl was never the query
 * plan — it was that ONE work fact on ONE sink invalidated the whole canvas
 * and forced a rebuild of every sink in it. Residency plus per-sink
 * invalidation turns that back into work proportional to what changed.
 *
 * FRESHNESS RESTS ON EXACTLY THE WITNESS THE PROJECTION CACHE ALREADY USED,
 * and this is the load-bearing correctness argument, so it is stated in full:
 *
 *   `work_canvas_revisions.revision` is bumped by AFTER INSERT/UPDATE/DELETE
 *   triggers on every table a snapshot projects from. The world serves
 *   resident snapshots ONLY when that counter is unchanged. So the world can
 *   never serve a canvas whose projected rows moved — it inherits the memo's
 *   envelope rather than inventing a second one, and any defect in the trigger
 *   set is a defect the shipped memo already had.
 *
 * WHEN THE COUNTER DOES MOVE, the world must decide what to re-read. It asks
 * the mutation seam, which announces the sink of every statement that can move
 * the counter, derived from the statement itself rather than declared by the
 * caller (see `work/mutation-seam.ts`). An announcement it cannot attribute
 * arrives as "somewhere, unknown", which drops the canvas back to a full
 * rebuild. The failure direction is a slow read, never a stale one.
 *
 * WHAT THIS IS NOT, YET. A dirty sink is re-read from SQLite rather than
 * mutated in place by the fact that dirtied it. That keeps ONE projection
 * implementation — the lane loaders — instead of a second fold that could
 * disagree with them, which is the trade the "correctness outranks speed" rule
 * demands while the world is young. It bounds a read at one sink's rows
 * instead of the factory's; closing the last gap to O(delta) means applying
 * the record to the resident snapshot, and that is a separate, later change.
 */
import { CANVAS_REVISION_TABLES, onWorkMutation } from "./mutation-seam";
import { Effect } from "effect";
import type {
  CanvasWorkProjection,
  WorkProjectionReaderShape,
  WorkRepositoryError,
} from "./repository";
import type { WorkSnapshot as WorkSnapshotValue } from "@shared/work-model";

/**
 * Kill switch. `JUNTO_WORLD=0` puts every canvas read back on the
 * SQLite read path, with no residency and no seam subscription — the exact
 * code that ran before this module existed. It is read once, at module load:
 * a world that could be switched off halfway through a session would be
 * serving from a residency nobody was maintaining.
 */
export const workWorldEnabled: boolean = process.env.JUNTO_WORLD !== "0";

/**
 * How many canvases stay resident.
 *
 * The same bound, for the same reason, as the projection memo this replaces
 * (`WORK_PROJECTION_CACHE_CANVASES` in `canvases.ts`): sized to hold a
 * full-portfolio sweep — `box/activity-policy.ts` reads every canvas on
 * reconcile — so a sweep cannot evict the canvas the operator is looking at.
 *
 * It is a bound and not an unbounded map because residency is the whole point
 * of this module: without one, a large portfolio would retain every canvas's
 * sinks for the life of the process, which is strictly more memory than the
 * memo ever held. Evicting costs that canvas's next read one hydration.
 */
const WORLD_RESIDENT_CANVASES = 16;

/** One canvas's resident read model. */
type ResidentCanvas = {
  /**
   * The `work_canvas_revisions` value these snapshots are exact at. Serving
   * resident state is allowed only while SQLite still reports this value.
   */
  workRevision: string;
  /** Sink snapshots by node id. This is the world's node index. */
  readonly sinks: Map<string, WorkSnapshotValue>;
  /**
   * Resident node ids in `node_id` order. The SQLite sweep returns sinks
   * ORDER BY node_id, so this order is part of memory-vs-SQLite equivalence,
   * not a convenience — it is re-sorted only when membership changes.
   */
  order: ReadonlyArray<string>;
  /** `order` resolved through `sinks`. Rebuilt whenever either moves. */
  ordered: ReadonlyArray<WorkSnapshotValue>;
};

/** What the world did to answer one read. Diagnostics only. */
export type WorkWorldReadKind =
  /** Counter unchanged: served from memory, no sink touched. */
  | "resident"
  /** First read of this canvas, or a coarse invalidation: full sweep. */
  | "hydrate"
  /** Counter moved: only the announced sinks were re-read. */
  | "incremental";

export type WorkWorldStats = {
  readonly canvases: number;
  readonly sinks: number;
  readonly resident: number;
  readonly hydrate: number;
  readonly incremental: number;
  /** Sinks re-read on incremental refreshes, cumulative. */
  readonly sinksReloaded: number;
  /** Announcements the seam could not attribute to a sink, cumulative. */
  readonly coarse: number;
  /** Canvases dropped to stay inside the residency bound, cumulative. */
  readonly evicted: number;
};

export type WorkWorld = {
  /**
   * Prepare in the same SQL read lease that read workRevision. Publish only
   * after the lease succeeds. Caller-owned write transactions bypass the world.
   */
  readonly prepare: (
    canvasName: string,
    workRevision: string,
  ) => Effect.Effect<
    { readonly projection: CanvasWorkProjection; readonly publish: () => void },
    WorkRepositoryError
  >;
  /** Read-lease convenience for callers that cannot roll back projected rows. */
  readonly projection: (
    canvasName: string,
    workRevision: string,
  ) => Effect.Effect<CanvasWorkProjection, WorkRepositoryError>;
  /** Stop holding a canvas — it left the portfolio. */
  readonly evict: (canvasName: string) => void;
  /** Drop everything. The next read of any canvas hydrates from SQLite. */
  readonly reset: () => void;
  readonly stats: () => WorkWorldStats;
  /** Unsubscribe from the seam. Idempotent. */
  readonly close: () => void;
};

/**
 * `node_id` order, exactly as SQLite's `ORDER BY node_id` produces it.
 *
 * SQLite stores TEXT as UTF-8 and its default BINARY collation is a byte
 * compare, so this compares UTF-8 bytes. Neither `<` on a JavaScript string
 * (UTF-16 code units, which disagree above the BMP) nor `localeCompare`
 * (locale order, which disagrees almost everywhere) is the same order, and a
 * different order is a different projected document. The schema constrains
 * `node_id` only by length, so the comparison cannot assume ASCII.
 *
 * Only membership changes re-sort. A refresh that replaces snapshots keeps
 * the order SQLite already gave.
 */
const compareNodeIds = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const sortedNodeIds = (
  sinks: ReadonlyMap<string, WorkSnapshotValue>,
): ReadonlyArray<string> => [...sinks.keys()].sort(compareNodeIds);

const resolveOrder = (
  order: ReadonlyArray<string>,
  sinks: ReadonlyMap<string, WorkSnapshotValue>,
): ReadonlyArray<WorkSnapshotValue> =>
  order.map((nodeId) => sinks.get(nodeId) as WorkSnapshotValue);

/**
 * Build a world and subscribe it to the mutation seam.
 *
 * One per state engine. The seam broadcasts every mutation in the process to
 * every world, so a second engine's writes cost this world a reload it did not
 * need — never a read it should not have served.
 */
export const makeWorkWorld = (reader: WorkProjectionReaderShape): WorkWorld => {
  const canvases = new Map<string, ResidentCanvas>();
  /** Announced-but-unapplied sinks, per canvas. */
  const dirty = new Map<string, Set<string>>();
  /** Every canvas is suspect: an announcement named no sink. */
  let coarse = false;
  let residentReads = 0;
  let hydrateReads = 0;
  let incrementalReads = 0;
  let sinksReloaded = 0;
  let coarseAnnouncements = 0;
  let evictions = 0;
  let epoch = 0;

  /** Re-insert so Map iteration order is least-recently-read first. */
  const retain = (canvasName: string, resident: ResidentCanvas): void => {
    canvases.delete(canvasName);
    canvases.set(canvasName, resident);
    while (canvases.size > WORLD_RESIDENT_CANVASES) {
      const oldest = canvases.keys().next();
      if (oldest.done === true) break;
      canvases.delete(oldest.value);
      dirty.delete(oldest.value);
      evictions += 1;
    }
  };

  const unsubscribe = onWorkMutation((canvasName, nodeId) => {
    epoch += 1;
    if (canvasName === undefined || nodeId === undefined) {
      coarse = true;
      coarseAnnouncements += 1;
      return;
    }
    const sinks = dirty.get(canvasName);
    if (sinks === undefined) dirty.set(canvasName, new Set([nodeId]));
    else sinks.add(nodeId);
  });

  const hydrate = Effect.fn("work.world.hydrate")(function* (
    canvasName: string,
    workRevision: string,
  ) {
    const snapshots = yield* reader.canvasSnapshots(canvasName);
    const sinks = new Map<string, WorkSnapshotValue>();
    for (const snapshot of snapshots) sinks.set(snapshot.nodeId, snapshot);
    // The sweep already returns node_id order; keep its array rather than
    // re-sorting an order SQLite just produced.
    const resident: ResidentCanvas = {
      workRevision,
      sinks,
      order: snapshots.map((snapshot) => snapshot.nodeId),
      ordered: snapshots,
    };
    return resident;
  });

  const refresh = Effect.fn("work.world.refresh")(function* (
    canvasName: string,
    resident: ResidentCanvas,
    workRevision: string,
    sinkIds: ReadonlySet<string>,
  ) {
    let membershipChanged = false;
    const sinks = new Map(resident.sinks);
    for (const nodeId of sinkIds) {
      const sink = { canvasName, nodeId };
      // Membership first, and by the same definition the sweep uses. A sink
      // whose last projected row is gone must LEAVE the projection: an
      // absent snapshot and an empty one are different documents.
      if (!(yield* reader.sinkIsProjected(sink))) {
        membershipChanged = sinks.delete(nodeId) || membershipChanged;
        continue;
      }
      if (!sinks.has(nodeId)) membershipChanged = true;
      sinks.set(nodeId, yield* reader.sinkSnapshot(sink));
    }
    const order = membershipChanged ? sortedNodeIds(sinks) : resident.order;
    const next: ResidentCanvas = {
      workRevision,
      sinks,
      order,
      // A fresh array every refresh: the previous one is already held by a
      // caller's projection and must never change under it.
      ordered: resolveOrder(order, sinks),
    };
    return next;
  });

  const prepare = Effect.fn("work.world.prepare")(function* (
    canvasName: string,
    workRevision: string,
  ) {
    const preparedEpoch = epoch;
    const wasCoarse = coarse;
    const resident = wasCoarse ? undefined : canvases.get(canvasName);
    const pending = wasCoarse ? undefined : dirty.get(canvasName);
    let kind: WorkWorldReadKind;
    let built: ResidentCanvas;
    if (resident !== undefined && resident.workRevision === workRevision) {
      kind = "resident";
      built = resident;
    } else if (
      resident === undefined ||
      pending === undefined ||
      pending.size === 0
    ) {
      kind = "hydrate";
      built = yield* hydrate(canvasName, workRevision);
    } else {
      kind = "incremental";
      built = yield* refresh(canvasName, resident, workRevision, pending);
    }
    let published = false;
    return {
      projection: { workRevision, snapshots: built.ordered },
      publish: () => {
        if (published || epoch !== preparedEpoch) return;
        published = true;
        if (wasCoarse) {
          canvases.clear();
          dirty.clear();
          coarse = false;
        }
        if (kind === "resident") residentReads += 1;
        else if (kind === "hydrate") hydrateReads += 1;
        else {
          incrementalReads += 1;
          sinksReloaded += pending!.size;
        }
        retain(canvasName, built);
        dirty.delete(canvasName);
      },
    };
  });

  const projection = Effect.fn("work.world.projection")(function* (
    canvasName: string,
    workRevision: string,
  ) {
    const prepared = yield* prepare(canvasName, workRevision);
    prepared.publish();
    return prepared.projection;
  });

  return {
    prepare,
    projection,
    evict: (canvasName) => {
      epoch += 1;
      canvases.delete(canvasName);
      dirty.delete(canvasName);
    },
    reset: () => {
      epoch += 1;
      canvases.clear();
      dirty.clear();
      coarse = false;
    },
    stats: () => ({
      canvases: canvases.size,
      sinks: [...canvases.values()].reduce(
        (total, entry) => total + entry.sinks.size,
        0,
      ),
      resident: residentReads,
      hydrate: hydrateReads,
      incremental: incrementalReads,
      sinksReloaded,
      coarse: coarseAnnouncements,
      evicted: evictions,
    }),
    close: () => {
      epoch += 1;
      unsubscribe();
      canvases.clear();
      dirty.clear();
    },
  };
};

/** Re-exported so callers can assert the witness set without a second import. */
export { CANVAS_REVISION_TABLES };
