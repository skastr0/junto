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
import {
  CANVAS_REVISION_TABLES,
  onWorkMutation,
} from "./mutation-seam";
import {
  readCanvasSinkSnapshots,
  readSinkSnapshot,
  sinkIsProjected,
  type CanvasWorkProjection,
} from "./repository";
import type { StateReader } from "../state/service";
import type { WorkSnapshot as WorkSnapshotValue } from "@shared/work-model";

/**
 * Kill switch. `VELLUM_COMMAND_WORLD=0` puts every canvas read back on the
 * SQLite read path, with no residency and no seam subscription — the exact
 * code that ran before this module existed. It is read once, at module load:
 * a world that could be switched off halfway through a session would be
 * serving from a residency nobody was maintaining.
 */
export const workWorldEnabled: boolean =
  process.env.VELLUM_COMMAND_WORLD !== "0";

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
   * This canvas's work projection at `workRevision`.
   *
   * `workRevision` MUST be the value the caller just read from
   * `work_canvas_revisions` through THIS reader, inside the same
   * `state.read`. The world serves residency by comparing against it, so a
   * stale or second-hand value is the one way to make this return stale data.
   *
   * The reader must be a StateReader from `state.read`, never a StateWriter:
   * inside a transaction it would see uncommitted rows, and a rollback would
   * leave the world resident on state that never existed.
   */
  readonly projection: (
    reader: StateReader,
    canvasName: string,
    workRevision: string,
  ) => CanvasWorkProjection;
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
export const makeWorkWorld = (): WorkWorld => {
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
    if (canvasName === undefined || nodeId === undefined) {
      coarse = true;
      coarseAnnouncements += 1;
      return;
    }
    const sinks = dirty.get(canvasName);
    if (sinks === undefined) dirty.set(canvasName, new Set([nodeId]));
    else sinks.add(nodeId);
  });

  const hydrate = (
    reader: StateReader,
    canvasName: string,
    workRevision: string,
  ): ResidentCanvas => {
    const snapshots = readCanvasSinkSnapshots(reader, canvasName);
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
    retain(canvasName, resident);
    dirty.delete(canvasName);
    return resident;
  };

  const refresh = (
    reader: StateReader,
    canvasName: string,
    resident: ResidentCanvas,
    workRevision: string,
    sinkIds: ReadonlySet<string>,
  ): ResidentCanvas => {
    let membershipChanged = false;
    for (const nodeId of sinkIds) {
      const sink = { canvasName, nodeId };
      // Membership first, and by the same definition the sweep uses. A sink
      // whose last projected row is gone must LEAVE the projection: an
      // absent snapshot and an empty one are different documents.
      if (!sinkIsProjected(reader, sink)) {
        membershipChanged = resident.sinks.delete(nodeId) || membershipChanged;
        sinksReloaded += 1;
        continue;
      }
      if (!resident.sinks.has(nodeId)) membershipChanged = true;
      resident.sinks.set(nodeId, readSinkSnapshot(reader, sink));
      sinksReloaded += 1;
    }
    const order = membershipChanged
      ? sortedNodeIds(resident.sinks)
      : resident.order;
    const next: ResidentCanvas = {
      workRevision,
      sinks: resident.sinks,
      order,
      // A fresh array every refresh: the previous one is already held by a
      // caller's projection and must never change under it.
      ordered: resolveOrder(order, resident.sinks),
    };
    retain(canvasName, next);
    dirty.delete(canvasName);
    return next;
  };

  const projection = (
    reader: StateReader,
    canvasName: string,
    workRevision: string,
  ): CanvasWorkProjection => {
    if (coarse) {
      // An announcement named no sink, so no canvas may be trusted to be
      // repairable sink by sink. Drop the whole residency and rebuild what is
      // asked for; this is the pre-world cost, paid only here.
      canvases.clear();
      dirty.clear();
      coarse = false;
    }
    const resident = canvases.get(canvasName);
    if (resident !== undefined && resident.workRevision === workRevision) {
      const pending = dirty.get(canvasName);
      if (pending === undefined || pending.size === 0) {
        residentReads += 1;
        retain(canvasName, resident);
        return { workRevision, snapshots: resident.ordered };
      }
      // The counter did not move but a mutation was announced: a rolled-back
      // transaction, or a write to a table outside the trigger set. Neither
      // can have changed a projected row, so the residency is still exact —
      // drop the marks rather than re-read for nothing.
      dirty.delete(canvasName);
      residentReads += 1;
      retain(canvasName, resident);
      return { workRevision, snapshots: resident.ordered };
    }
    const pending = dirty.get(canvasName);
    if (resident === undefined || pending === undefined || pending.size === 0) {
      // No residency to repair, or the counter moved with nothing announced
      // for this canvas (a write this process did not make, or an
      // announcement lost to a coarse reset). Rebuild from SQLite.
      hydrateReads += 1;
      const built = hydrate(reader, canvasName, workRevision);
      return { workRevision, snapshots: built.ordered };
    }
    incrementalReads += 1;
    const built = refresh(reader, canvasName, resident, workRevision, pending);
    return { workRevision, snapshots: built.ordered };
  };

  return {
    projection,
    evict: (canvasName) => {
      canvases.delete(canvasName);
      dirty.delete(canvasName);
    },
    reset: () => {
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
      unsubscribe();
      canvases.clear();
      dirty.clear();
    },
  };
};

/** Re-exported so callers can assert the witness set without a second import. */
export { CANVAS_REVISION_TABLES };
