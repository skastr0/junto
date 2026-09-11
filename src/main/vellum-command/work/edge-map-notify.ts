/**
 * One edge-notification theory: when a canvas commit adds or removes
 * slot-bearing edges for an agent seat, deliver exactly one compact map-change
 * notice — added ids inline, removals as a re-orient hint. Never a full
 * doctrine re-injection, never a duplicate from a parallel subsystem.
 *
 * Flush-window coalescing (PROTO-1/PROTO-4 law): commits landing inside one
 * short flush window merge into ONE net-diff notice per seat — A->B->C in one
 * window is a single "Added B, C" notice, and A->B->A nets to zero notices.
 * The window is a real-timer debounce refreshed by every commit; at flush the
 * accumulated grant delta is diffed against the last-NOTIFIED adjacency
 * snapshot per (canvas, seat) and suppressed when the grant set is unchanged.
 * The snapshot only advances when a notice is actually delivered, so a
 * real grant change is never swallowed by a later no-op round-trip.
 *
 * The former actor↔actor msg.send-enable notice path is folded into this
 * engine: an agent edge's msg contract arrives with the map change, so a
 * separate link notice would be a second, equivalent notification from a
 * different part of the program — the failure mode this module exists to
 * prevent.
 */

import { Context, Effect } from "effect";
import { ulid } from "ulid";
import type { CanvasDoc } from "@shared/canvas";
import {
  composeEdgeMapChangeNotice,
  planEdgeMapChanges,
  type EdgeMapChange,
  type InjectionConnectedTarget,
} from "@shared/managed-terminal-injection";
import { makeUserMessage } from "@shared/task";
import type { CanvasChangeDetail } from "../canvases";
import { WorkService } from "./service";

/**
 * One flush window: commits (or notify calls) landing within this many
 * milliseconds of each other coalesce into a single net-diff notice per seat.
 * Short enough that the protocol-loop tests' idle/delivery windows observe a
 * flushed notice (advance(20)/advance(30)), long enough that back-to-back
 * commits in one authorial burst land in the same window. 20ms is the
 * largest window the fake-timer test advances tolerate; the real chatter
 * reduction (one message per operator action) comes from this window plus
 * the net-diff suppression of repeated same-target commits.
 */
const FLUSH_WINDOW_MS = 20;

type PendingSeat = {
  /** Targets added inside the open window (key → target). */
  readonly added: Map<string, InjectionConnectedTarget>;
  /** Targets removed inside the open window (key → target). */
  readonly removed: Map<string, InjectionConnectedTarget>;
  /**
   * Grant-set snapshot (kind:id keys) the seat was last actually told about.
   * `undefined` = never notified (empty set). Only advanced on delivery.
   */
  lastNotified: ReadonlySet<string> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Fiber context captured from the caller's runtime (WorkService env). */
  ctx: Context.Context<WorkService> | undefined;
};

const pendingSeats = new Map<string, PendingSeat>();

const seatKeyOf = (canvas: string, seatId: string): string =>
  `${canvas}\u0000${seatId}`;

/** Same identity key as planEdgeMapChanges (`${kind}:${id}`). */
const targetKey = (t: InjectionConnectedTarget): string =>
  `${t.kind ?? ""}:${t.id}`;

const accumulate = (
  canvas: string,
  change: EdgeMapChange,
  ctx: Context.Context<WorkService>,
): void => {
  const key = seatKeyOf(canvas, change.seatId);
  let seat = pendingSeats.get(key);
  if (seat === undefined) {
    seat = {
      added: new Map(),
      removed: new Map(),
      lastNotified: undefined,
      timer: undefined,
      ctx,
    };
    pendingSeats.set(key, seat);
  }
  seat.ctx = ctx;
  // Net-cancel within the window: a target both added and removed cancels.
  for (const t of change.added) {
    const k = targetKey(t);
    if (seat.removed.delete(k)) continue;
    seat.added.set(k, t);
  }
  for (const t of change.removed) {
    const k = targetKey(t);
    if (seat.added.delete(k)) continue;
    seat.removed.set(k, t);
  }
  if (seat.timer !== undefined) clearTimeout(seat.timer);
  seat.timer = setTimeout(() => {
    if (seat === undefined) return;
    seat.timer = undefined;
    flush(canvas, change.seatId, seat);
  }, FLUSH_WINDOW_MS);
};

const restoreDelta = (
  seat: PendingSeat,
  added: readonly InjectionConnectedTarget[],
  removed: readonly InjectionConnectedTarget[],
): void => {
  for (const t of added) seat.added.set(targetKey(t), t);
  for (const t of removed) seat.removed.set(targetKey(t), t);
};

/**
 * Flush one seat's open window: diff the accumulated delta against the
 * last-notified snapshot and deliver exactly ONE notice when the net grant
 * set actually changed; otherwise consume the window silently.
 */
const flushSeat = (
  canvas: string,
  seatId: string,
  seat: PendingSeat,
  delta: {
    readonly added: readonly InjectionConnectedTarget[];
    readonly removed: readonly InjectionConnectedTarget[];
  },
): Effect.Effect<number, never, WorkService> => {
  const { added, removed } = delta;
  const before = seat.lastNotified ?? new Set<string>();
  const current = new Set<string>(before);
  for (const t of added) current.add(targetKey(t));
  for (const t of removed) current.delete(targetKey(t));
  const netAdded = added.filter((t) => !before.has(targetKey(t)));
  const netRemoved = removed.filter((t) => before.has(targetKey(t)));
  // Grant set unchanged (e.g. A->B->A round-trip): suppress — no notice.
  if (netAdded.length === 0 && netRemoved.length === 0) {
    return Effect.succeed(0);
  }
  return Effect.gen(function* () {
    const work = yield* WorkService;
    const result = yield* work.workSystemMailboxNotify(
      canvas,
      seatId,
      makeUserMessage({
        messageId: ulid(),
        text: composeEdgeMapChangeNotice({
          seatId,
          added: netAdded,
          removed: netRemoved,
        }),
        contextId: canvas,
        metadata: {
          factoryLink: true,
          edgeMapChange: true,
          addedIds: netAdded.map((t) => t.id),
          removedIds: netRemoved.map((t) => t.id),
        },
      }),
    );
    if (result.ok) {
      // Only advance the snapshot on real delivery; a failed send keeps the
      // delta pending for a later window.
      seat.lastNotified = current;
      return 1;
    }
    restoreDelta(seat, added, removed);
    return 0;
  }).pipe(
    Effect.catch(() => {
      restoreDelta(seat, added, removed);
      return Effect.succeed(0);
    }),
  );
};

const flush = (
  canvas: string,
  seatId: string,
  seat: PendingSeat,
): void => {
  const ctx = seat.ctx;
  if (ctx === undefined) return;
  // Drain synchronously at window close; later commits open a fresh window.
  const added = [...seat.added.values()];
  const removed = [...seat.removed.values()];
  seat.added.clear();
  seat.removed.clear();
  if (added.length === 0 && removed.length === 0) return;
  // Run the flush effect on the captured caller context (same services the
  // deliver call had), outside the original fiber.
  void Effect.runPromiseWith(ctx)(flushSeat(canvas, seatId, seat, { added, removed })).catch(
    () => {
      restoreDelta(seat, added, removed);
    },
  );
};

export const deliverEdgeMapChangeNotices = (input: {
  readonly canvas: string;
  readonly previous: CanvasDoc;
  readonly next: CanvasDoc;
}): Effect.Effect<number, never, WorkService> =>
  Effect.gen(function* () {
    const changes = planEdgeMapChanges(input.previous, input.next);
    if (changes.length === 0) return 0;
    const ctx = yield* Effect.context<WorkService>();
    for (const change of changes) {
      accumulate(input.canvas, change, ctx);
    }
    // Delivery is deferred to the flush window; the count is settled there.
    return 0;
  }).pipe(Effect.catch(() => Effect.succeed(0)));

/**
 * Canvas change listener body. No previous doc ⇒ skip (open / first paint /
 * work-projection ticks without authorial topology delta).
 */
export const onCanvasChangeForEdgeMap = (
  canvas: string,
  detail: CanvasChangeDetail | undefined,
): Effect.Effect<number, never, WorkService> => {
  if (detail?.previous === undefined || detail.next === undefined) {
    return Effect.succeed(0);
  }
  return deliverEdgeMapChangeNotices({
    canvas,
    previous: detail.previous,
    next: detail.next,
  });
};
