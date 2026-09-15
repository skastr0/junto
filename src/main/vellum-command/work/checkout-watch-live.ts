/**
 * Live checkout watch — production wiring around the pure commit watch.
 *
 * `checkout-watch.ts` holds the doctrine (baseline silence, exact
 * `(checkout, sha)` coalescing, attribution only from proven context) and stays
 * pure. This module supplies the three things that module deliberately does not
 * own: where commits come from, which seats are bound to which checkout right
 * now, and what happens to an attributed observation.
 *
 * Boundaries, so nothing is implemented twice:
 *
 * - Git access is read-only and goes through the existing `runCli` adapter, so
 *   every probe is bounded by its own timeout and serialized by the adapter
 *   process plane. No shell, no writes, no raw process control.
 * - The durable write of an observation is `CrewRepository.recordCheckoutObservation`
 *   (storage lane). This module only decides *when* an observation is recorded.
 * - Reviewer receipt mail is *not* composed here. Attributed commits are handed
 *   to an injected `deliverReceipts` seam, which owns the atomic
 *   receipt+mail write and its own idempotency (`receiptDedupeKey`).
 *
 * Ordering rule that makes the feed at-least-once without duplicate mail:
 * delivery precedes the observation record. The receipt writer is idempotent on
 * its own natural key, so a crash between the two re-delivers nothing twice,
 * while a failed delivery leaves the observation unrecorded and therefore
 * retried. A failed delivery is retained in memory and retried before the next
 * scan; a checkout whose observation range could not be enumerated keeps its
 * watermark, so the exact range is re-emitted rather than skipped.
 *
 * The writer is required to revalidate the current author, task and edge
 * authority at write time: a claim observed here is a trigger, never standing
 * authority, so a receipt cannot outlive the claim that caused it.
 *
 * Canvas identity is per watcher and fixed at construction. A watcher's pending
 * backlog and receipt groups are private to its canvas, so a stale observation
 * can never be delivered under another canvas's name; root composes one watcher
 * per live canvas (or uses the supervisor below, which reconciles them from the
 * live canvas list and drives them from a single timer). A pass is bounded by
 * the tracked checkout count and by the adapter timeout on every git call, and
 * the retry backlog is bounded by `CHECKOUT_WATCH_MAX_RETAINED`. `stop` is
 * authoritative: a scan already in flight re-checks it before every durable
 * write, so nothing new reaches the plane after stop.
 *
 * Attribution law (unchanged from the pure module, enforced on the input side
 * here): zero or several distinct active seats on one checkout yields an
 * unattributed observation — recorded, exposed, never seat-claimed. A seat with
 * no process binding on this canvas, no proven checkout, or a canonical
 * delivery surface on another host (Remote is out of this iteration) yields no
 * binding at all. This module never guesses a checkout from a default path.
 *
 * A checkout with no live claim is untracked. Re-attaching re-baselines
 * silently, because attach never synthesizes history.
 */

import { stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect, Result } from "effect";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import type { ActorSeatId } from "@shared/actor-seat";
import type { CanvasNode } from "@shared/canvas";
import { isGitSha } from "@shared/git";
import { DEFAULT_STATION_HOST_ID } from "@shared/station";
import { currentTaskOwner } from "@shared/task-owner";
import type { Task, TasksContract } from "@shared/work-model";
import type { ActorRef } from "@shared/work-reference";
import { runCli } from "../adapters/exec";
import {
  CheckoutWatcher,
  type CheckoutBinding,
  type CheckoutBindingVia,
  type CheckoutObservation,
  type GitProbe,
} from "./checkout-watch";
import type { CrewRepositoryShape } from "./crew-repository";

// ---------------------------------------------------------------------------
// Proven claim context.
// ---------------------------------------------------------------------------

/** One (checkout, seat, task) binding proven from live board + canvas facts. */
export type CheckoutWatchClaim = {
  readonly seatId: ActorSeatId;
  readonly taskId: string;
  readonly nodeId: string;
  /** Canonical worktree path. */
  readonly checkoutKey: string;
  readonly via: CheckoutBindingVia;
};

export type CheckoutWatchContext = {
  readonly canvasName: string;
  readonly claims: ReadonlyArray<CheckoutWatchClaim>;
};

/**
 * The raw facts a claim context is derived from. Everything here is a live
 * projection the caller already holds; nothing is persisted by derivation.
 */
export type CheckoutWatchFacts = {
  readonly canvasName: string;
  readonly tasks: ReadonlyArray<Task>;
  readonly contract: TasksContract | undefined;
  /** Live process-bound seats for this canvas (`canvas.actorRefs`). */
  readonly actorRefs: ReadonlyArray<ActorRef>;
  readonly nodes: ReadonlyArray<CanvasNode>;
  /**
   * Canonical worktree for a seat node, or undefined when none is proven.
   * Callers build this from durable launch `cwd` plus the live session `cwd`;
   * a node with no proven checkout yields no claim.
   */
  readonly checkoutKeyFor: (nodeId: string) => string | undefined;
};

/**
 * Derive the active binding set from live facts.
 *
 * A claim needs all four: a live non-terminal task whose owner is a seat
 * (`currentTaskOwner` — terminal rows notify nobody, a Me board has no seat
 * claimant), that seat process-bound on *this* canvas, a managed seat whose
 * canonical delivery surface is this host, and a proven canonical checkout for
 * that seat's node. Missing any one yields no claim rather than a guess.
 *
 * A seat binds one checkout: its process-bound node's proven worktree (the
 * first `actorRef` for a seat wins, so a duplicated ref cannot bind twice).
 * Several tasks for the same seat on the same checkout resolve to the later
 * board row; several distinct seats on one checkout is the ambiguity the
 * watcher refuses to attribute.
 */
export const claimContextFrom = (facts: CheckoutWatchFacts): CheckoutWatchContext => {
  const nodesById = new Map(facts.nodes.map((node) => [node.id, node]));
  const actorBySeat = new Map<string, ActorRef>();
  for (const ref of facts.actorRefs) {
    if (ref.canvasName !== facts.canvasName) continue;
    if (!actorBySeat.has(ref.seatId)) actorBySeat.set(ref.seatId, ref);
  }

  const claims = new Map<string, CheckoutWatchClaim>();
  for (const task of facts.tasks) {
    const claimed = task.claimedBy;
    if (claimed === undefined) continue;
    const owner = currentTaskOwner(task, facts.contract);
    if (owner.kind !== "seat" || owner.seatId !== claimed) continue;
    const ref = actorBySeat.get(claimed);
    if (ref === undefined) continue;
    const node = nodesById.get(ref.nodeId);
    if (node === undefined) continue;
    const surface = actorDeliverySurfaceOf(node);
    if (surface === undefined) continue;
    if (surface.hostId !== DEFAULT_STATION_HOST_ID) continue;
    const checkoutKey = facts.checkoutKeyFor(ref.nodeId)?.trim();
    if (checkoutKey === undefined || checkoutKey.length === 0) continue;
    claims.set(`${checkoutKey}\u0000${claimed}`, {
      seatId: claimed,
      taskId: task.id,
      nodeId: ref.nodeId,
      checkoutKey,
      via: "claim-context",
    });
  }
  return { canvasName: facts.canvasName, claims: [...claims.values()] };
};

/**
 * Canonical checkout identity: the resolved worktree path.
 *
 * Undefined for an empty path, a relative path (it names no durable checkout),
 * a path that does not resolve, and a path that is not a directory. The
 * expansion mirrors the git adapter so `~`-rooted launch cwd values resolve.
 */
export const checkoutKeyFromPath = async (
  raw: string | undefined,
): Promise<string | undefined> => {
  const requested = raw?.trim() ?? "";
  if (requested.length === 0 || requested.includes("\0")) return undefined;
  const expanded =
    requested === "~"
      ? homedir()
      : requested.startsWith("~/")
        ? join(homedir(), requested.slice(2))
        : requested;
  if (!isAbsolute(expanded)) return undefined;
  try {
    const root = await realpath(expanded);
    const info = await stat(root);
    return info.isDirectory() ? root : undefined;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// Git probe over the read-only adapter.
// ---------------------------------------------------------------------------

/** Bounded per-probe git timeout; the adapter plane owns the actual spawn. */
export const GIT_PROBE_TIMEOUT_MS = 15_000;

/**
 * The production `GitProbe`. Read-only `rev-parse` / `rev-list` through
 * `runCli`, so each call is timeout-bounded and serialized by the adapter
 * process plane, and nothing here ever writes to a worktree.
 */
export const gitProbeOverRunCli = (
  options: { readonly timeoutMs?: number; readonly run?: typeof runCli } = {},
): GitProbe => {
  const timeoutMs = options.timeoutMs ?? GIT_PROBE_TIMEOUT_MS;
  const run = options.run ?? runCli;
  const git = (worktree: string, args: ReadonlyArray<string>) =>
    run("git", ["-C", worktree, ...args], timeoutMs);

  return {
    async head(worktree) {
      const branch = await git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (!branch.ok) return undefined;
      const resolved = await git(worktree, ["rev-parse", "HEAD"]);
      const head = resolved.stdout.trim().toLowerCase();
      if (!resolved.ok || !isGitSha(head)) return undefined;
      return { branch: branch.stdout.trim(), head };
    },
    async newCommits(worktree, fromExclusive, toInclusive) {
      const listed = await git(worktree, [
        "rev-list",
        toInclusive,
        "--not",
        fromExclusive,
      ]);
      if (!listed.ok) {
        throw new Error(listed.error ?? `git rev-list failed in ${worktree}`);
      }
      return listed.stdout
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter((line) => isGitSha(line));
    },
  };
};

// ---------------------------------------------------------------------------
// Live watch.
// ---------------------------------------------------------------------------

export type CheckoutWatchReceiptFailure = {
  readonly reason: string;
  readonly message: string;
};

/** Ingredients of one attributed receipt delivery, grouped per (checkout, task, seat). */
export type CheckoutReceiptMailInput = {
  readonly canvasName: string;
  readonly checkoutKey: string;
  readonly taskId: string;
  readonly authorSeatId: ActorSeatId;
  readonly shas: ReadonlyArray<string>;
};

export type CheckoutWatchScanReceipt = {
  readonly scannedAt: number;
  /** Checkouts currently tracked. */
  readonly checkouts: number;
  /** Commits emitted by this pass's scan (fresh; excludes retried backlog). */
  readonly observed: number;
  /** Observations in this pass that carried proven seat/task context. */
  readonly attributed: number;
  /** Observations the durable plane already held. */
  readonly coalesced: number;
  readonly receiptsDelivered: number;
  /** Observations carried into the next pass after a failed delivery or record. */
  readonly retained: number;
  /** Retained observations dropped past the backlog bound. */
  readonly dropped: number;
  /** Failures in this pass: scan, delivery, or record. */
  readonly failed: number;
  /** True when this call joined a scan that was already running. */
  readonly joined: boolean;
};

export type CheckoutWatchLiveOptions = {
  /**
   * The one canvas this watcher belongs to, fixed at construction. Pending
   * observations and receipt groups therefore can never be delivered under a
   * different canvas: the backlog is private to this canvas's watcher, and
   * root composes one watcher per live canvas.
   */
  readonly canvasName: string;
  readonly probe: GitProbe;
  /** Observation sink; the storage lane owns the write. */
  readonly repository: Pick<CrewRepositoryShape, "recordCheckoutObservation">;
  /**
   * Re-read every scan: the binding set is live, never cached across passes.
   * Claims for any other canvas are a composition error and are ignored.
   */
  readonly claims: () => Effect.Effect<ReadonlyArray<CheckoutWatchClaim>, never>;
  /**
   * Atomic reviewer receipt+mail write for attributed commits.
   *
   * Required of the implementation: it revalidates the current author, task
   * and edge authority at write time — a claim observed here is only the
   * trigger, never standing authority — and it is idempotent on its own
   * natural key, because the same group may arrive twice after a failed record
   * or a re-emitted range.
   */
  readonly deliverReceipts: (
    input: CheckoutReceiptMailInput,
  ) => Effect.Effect<void, CheckoutWatchReceiptFailure>;
  /** Runner for timer-driven scans. The app runtime supplies it. */
  readonly run: <A>(effect: Effect.Effect<A, never, never>) => Promise<A>;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly onError?: (error: unknown) => void;
};

export type CheckoutWatchLive = {
  /** One bounded pass. Concurrent callers join the in-flight pass. */
  readonly scanOnce: () => Effect.Effect<CheckoutWatchScanReceipt, never>;
  readonly start: () => void;
  readonly stop: () => void;
  /**
   * Clear the stop mark without installing a timer. For a caller that owns the
   * poll schedule and drives `scanOnce` itself (the multi-canvas supervisor).
   */
  readonly resume: () => void;
  readonly trackedCheckouts: () => ReadonlyArray<string>;
  readonly bindings: () => ReadonlyArray<CheckoutBinding>;
  /** True while this watcher owns a poll timer. */
  readonly polling: () => boolean;
};

export const CHECKOUT_WATCH_DEFAULT_POLL_MS = 10_000;
const CHECKOUT_WATCH_MIN_POLL_MS = 250;
/**
 * Bound on the retry backlog. A delivery or record failure retains its
 * observation, so a pathological writer could otherwise grow the backlog
 * without limit; past this many, the oldest retained observations are dropped
 * and reported. The durable `(checkout, sha)` plane is the real coalescer, so a
 * drop costs at most one receipt, never a duplicate.
 */
export const CHECKOUT_WATCH_MAX_RETAINED = 1_024;

type DrainCounts = {
  readonly attributed: number;
  readonly coalesced: number;
  readonly receiptsDelivered: number;
  readonly retained: number;
  readonly dropped: number;
  readonly failed: number;
};

export const makeCheckoutWatchLive = (
  options: CheckoutWatchLiveOptions,
): CheckoutWatchLive => {
  const now = options.now ?? (() => Date.now());
  const pollMs = Math.max(CHECKOUT_WATCH_MIN_POLL_MS, options.pollMs ?? CHECKOUT_WATCH_DEFAULT_POLL_MS);
  const canvasName = options.canvasName;

  // Observations arrive from the watcher's synchronous emission point; the
  // durable drain runs immediately after, and anything that fails stays here
  // until it succeeds.
  let pending: CheckoutObservation[] = [];
  const watcher = new CheckoutWatcher(options.probe, (observations) => {
    pending = [...pending, ...observations];
  });

  const applied = new Map<string, CheckoutBinding>();
  const tracked = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<CheckoutWatchScanReceipt> | undefined;
  // `stop` is authoritative: no durable write happens after it, including from
  // a scan that was already in flight.
  let stopped = false;

  const bindingKey = (checkoutKey: string, seatId: ActorSeatId) =>
    `${checkoutKey}\u0000${seatId}`;

  /** Track, bind and release so the watcher's view equals the live claims. */
  const applyContext = (claims: ReadonlyArray<CheckoutWatchClaim>): void => {
    const desired = new Map<string, CheckoutBinding>();
    for (const claim of claims) {
      if (claim.checkoutKey.length === 0) continue;
      desired.set(bindingKey(claim.checkoutKey, claim.seatId), {
        checkoutKey: claim.checkoutKey,
        seatId: claim.seatId,
        taskId: claim.taskId,
        via: claim.via,
      });
    }
    for (const [key, binding] of [...applied]) {
      if (desired.has(key)) continue;
      watcher.bindings().release(binding.checkoutKey, binding.seatId);
      applied.delete(key);
    }
    for (const [key, binding] of desired) {
      watcher.track(
        { checkoutKey: binding.checkoutKey, worktree: binding.checkoutKey },
        binding,
      );
      applied.set(key, binding);
      tracked.add(binding.checkoutKey);
    }
    const live = new Set([...desired.values()].map((binding) => binding.checkoutKey));
    for (const checkoutKey of [...tracked]) {
      if (live.has(checkoutKey)) continue;
      watcher.untrack(checkoutKey);
      tracked.delete(checkoutKey);
    }
  };

  const record = (
    observation: CheckoutObservation,
    attributed: { readonly seatId: ActorSeatId; readonly taskId: string } | undefined,
    at: number,
  ) =>
    options.repository
      .recordCheckoutObservation({
        checkoutKey: observation.checkoutKey,
        sha: observation.sha,
        ...(attributed !== undefined
          ? {
              seatId: attributed.seatId,
              taskId: attributed.taskId,
              attributedVia: observation.attributedVia ?? "claim-context",
            }
          : {}),
        observedAt: new Date(at).toISOString(),
      })
      .pipe(Effect.result);

  const emptyCounts = (): DrainCounts => ({
    attributed: 0,
    coalesced: 0,
    receiptsDelivered: 0,
    retained: pending.length,
    dropped: 0,
    failed: 0,
  });

  const drain = (at: number): Effect.Effect<DrainCounts, never> =>
    Effect.gen(function* () {
      if (pending.length === 0 || stopped) return emptyCounts();
      const batch = pending;
      pending = [];
      const retained: CheckoutObservation[] = [];
      const groups = new Map<
        string,
        { readonly checkoutKey: string; readonly taskId: string; readonly seatId: ActorSeatId; readonly observations: CheckoutObservation[] }
      >();
      let attributed = 0;
      let coalesced = 0;
      let failed = 0;

      for (const observation of batch) {
        // `stop` is authoritative: anything not yet written goes back to the
        // backlog rather than reaching the durable plane.
        if (stopped) {
          retained.push(observation);
          continue;
        }
        if (observation.seatId === undefined || observation.taskId === undefined) {
          // Unattributed: recorded, exposed, never seat-claimed.
          const recorded = yield* record(observation, undefined, at);
          if (Result.isFailure(recorded)) {
            failed += 1;
            retained.push(observation);
            options.onError?.(recorded.failure);
            continue;
          }
          if (!recorded.success) coalesced += 1;
          continue;
        }
        attributed += 1;
        const key = `${observation.checkoutKey}\u0000${observation.taskId}\u0000${observation.seatId}`;
        const group = groups.get(key) ?? {
          checkoutKey: observation.checkoutKey,
          taskId: observation.taskId,
          seatId: observation.seatId,
          observations: [],
        };
        group.observations.push(observation);
        groups.set(key, group);
      }

      let receiptsDelivered = 0;
      for (const group of groups.values()) {
        if (stopped) {
          retained.push(...group.observations);
          continue;
        }
        const delivered = yield* Effect.result(
          options.deliverReceipts({
            canvasName,
            checkoutKey: group.checkoutKey,
            taskId: group.taskId,
            authorSeatId: group.seatId,
            shas: group.observations.map((observation) => observation.sha),
          }),
        );
        if (Result.isFailure(delivered)) {
          // Delivery precedes the record, so the group is retained and retried
          // rather than coalesced away.
          failed += 1;
          retained.push(...group.observations);
          options.onError?.(delivered.failure);
          continue;
        }
        receiptsDelivered += 1;
        for (const observation of group.observations) {
          if (stopped) {
            retained.push(observation);
            continue;
          }
          const recorded = yield* record(
            observation,
            { seatId: group.seatId, taskId: group.taskId },
            at,
          );
          if (Result.isFailure(recorded)) {
            failed += 1;
            retained.push(observation);
            options.onError?.(recorded.failure);
            continue;
          }
          if (!recorded.success) coalesced += 1;
        }
      }

      const backlog = [...retained, ...pending];
      const dropped =
        backlog.length > CHECKOUT_WATCH_MAX_RETAINED
          ? backlog.length - CHECKOUT_WATCH_MAX_RETAINED
          : 0;
      pending = dropped === 0 ? backlog : backlog.slice(dropped);
      if (dropped > 0) {
        options.onError?.(
          new Error(
            `checkout watch: dropped ${dropped} retained observation(s) past ${CHECKOUT_WATCH_MAX_RETAINED}`,
          ),
        );
      }
      return {
        attributed,
        coalesced,
        receiptsDelivered,
        retained: pending.length,
        dropped,
        failed,
      };
    });

  const receipt = (
    scannedAt: number,
    observed: number,
    counts: DrainCounts,
  ): CheckoutWatchScanReceipt => ({
    scannedAt,
    checkouts: tracked.size,
    observed,
    attributed: counts.attributed,
    coalesced: counts.coalesced,
    receiptsDelivered: counts.receiptsDelivered,
    retained: counts.retained,
    dropped: counts.dropped,
    failed: counts.failed,
    joined: false,
  });

  const scanEffect = (): Effect.Effect<CheckoutWatchScanReceipt, never> =>
    Effect.gen(function* () {
      const at = now();
      if (stopped) return receipt(at, 0, emptyCounts());
      const claims = yield* options.claims();
      if (stopped) return receipt(at, 0, emptyCounts());
      applyContext(claims);
      const scanned = yield* Effect.result(
        Effect.tryPromise({
          try: () => watcher.scan(),
          catch: (error) => error,
        }),
      );
      if (Result.isFailure(scanned)) {
        options.onError?.(scanned.failure);
        const counts = yield* drain(now());
        return receipt(at, 0, { ...counts, failed: counts.failed + 1 });
      }
      const counts = yield* drain(now());
      return receipt(at, scanned.success.length, counts);
    });

  const scanOnce = (): Effect.Effect<CheckoutWatchScanReceipt, never> =>
    Effect.suspend(() => {
      const running = inFlight;
      if (running !== undefined) {
        return Effect.promise(async () => ({ ...(await running), joined: true }));
      }
      const flight = options.run(scanEffect());
      inFlight = flight;
      return Effect.promise(async () => {
        try {
          return await flight;
        } finally {
          if (inFlight === flight) inFlight = undefined;
        }
      });
    });

  const drive = (): void => {
    void options
      .run(scanOnce())
      .then(() => undefined)
      .catch((error: unknown) => options.onError?.(error));
  };

  return {
    scanOnce,
    resume: () => {
      stopped = false;
    },
    start: () => {
      stopped = false;
      if (timer !== undefined) return;
      // One immediate pass establishes each tracked checkout's baseline before
      // the first poll; it is silent by doctrine.
      drive();
      timer = setInterval(drive, pollMs);
      timer.unref?.();
    },
    stop: () => {
      // Authoritative: a scan already in flight re-checks this before every
      // durable write, so nothing new reaches the plane after stop.
      stopped = true;
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
    trackedCheckouts: () => [...tracked],
    bindings: () => [...applied.values()],
    polling: () => timer !== undefined,
  };
};

// ---------------------------------------------------------------------------
// Multi-canvas supervisor.
// ---------------------------------------------------------------------------

export type CheckoutWatchSupervisorOptions = {
  readonly probe: GitProbe;
  readonly repository: Pick<CrewRepositoryShape, "recordCheckoutObservation">;
  /** Live canvas names, re-read every pass. */
  readonly canvases: () => Effect.Effect<ReadonlyArray<string>, never>;
  /** Claims for one canvas, re-read every pass. */
  readonly claims: (
    canvasName: string,
  ) => Effect.Effect<ReadonlyArray<CheckoutWatchClaim>, never>;
  readonly deliverReceipts: (
    input: CheckoutReceiptMailInput,
  ) => Effect.Effect<void, CheckoutWatchReceiptFailure>;
  readonly run: <A>(effect: Effect.Effect<A, never, never>) => Promise<A>;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly onError?: (error: unknown) => void;
};

export type CheckoutWatchCanvasReceipt = {
  readonly canvasName: string;
  readonly receipt: CheckoutWatchScanReceipt;
};

export type CheckoutWatchSupervisor = {
  /**
   * Reconcile one watcher per live canvas. Called at the start of every pass,
   * so a canvas that appears or closes is picked up without extra wiring.
   */
  readonly sync: () => Effect.Effect<ReadonlyArray<string>, never>;
  /** One bounded pass over every live canvas, in stable name order. */
  readonly scanOnce: () => Effect.Effect<ReadonlyArray<CheckoutWatchCanvasReceipt>, never>;
  readonly start: () => void;
  readonly stop: () => void;
  readonly canvases: () => ReadonlyArray<string>;
};

/**
 * One watcher per live canvas, driven by one timer.
 *
 * Canvas identity is per watcher and fixed, so a canvas's pending observations
 * and receipt groups can never be delivered under another canvas's name, and
 * closing a canvas stops its watcher (no post-stop writes) while the others
 * keep polling. Canvases are scanned sequentially in name order: a pass is
 * bounded by the canvas count, and each canvas's own pass stays serialized.
 */
export const makeCheckoutWatchSupervisor = (
  options: CheckoutWatchSupervisorOptions,
): CheckoutWatchSupervisor => {
  const watchers = new Map<string, CheckoutWatchLive>();
  let timer: ReturnType<typeof setInterval> | undefined;
  // Mirrors the watchers' stop mark so a canvas created after `stop` starts
  // stopped rather than polling once on creation.
  let stopped = false;

  const watcherFor = (canvasName: string): CheckoutWatchLive => {
    const existing = watchers.get(canvasName);
    if (existing !== undefined) return existing;
    const created = makeCheckoutWatchLive({
      canvasName,
      probe: options.probe,
      repository: options.repository,
      claims: () => options.claims(canvasName),
      deliverReceipts: options.deliverReceipts,
      run: options.run,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
    });
    if (stopped) created.stop();
    watchers.set(canvasName, created);
    return created;
  };

  const sync = (): Effect.Effect<ReadonlyArray<string>, never> =>
    Effect.gen(function* () {
      const live = [...(yield* options.canvases())].sort();
      const keep = new Set(live);
      for (const [canvasName, watcher] of [...watchers]) {
        if (keep.has(canvasName)) continue;
        watcher.stop();
        watchers.delete(canvasName);
      }
      for (const canvasName of live) watcherFor(canvasName);
      return live;
    });

  const scanOnce = (): Effect.Effect<ReadonlyArray<CheckoutWatchCanvasReceipt>, never> =>
    Effect.gen(function* () {
      const live = yield* sync();
      const receipts: CheckoutWatchCanvasReceipt[] = [];
      for (const canvasName of live) {
        const watcher = watchers.get(canvasName);
        if (watcher === undefined) continue;
        receipts.push({ canvasName, receipt: yield* watcher.scanOnce() });
      }
      return receipts;
    });

  const drive = (): void => {
    void options
      .run(scanOnce())
      .then(() => undefined)
      .catch((error: unknown) => options.onError?.(error));
  };

  return {
    sync,
    scanOnce,
    start: () => {
      stopped = false;
      // Each canvas watcher is driven by this supervisor's single timer, so it
      // is resumed rather than started (no per-canvas timers).
      for (const watcher of watchers.values()) watcher.resume();
      if (timer !== undefined) return;
      drive();
      timer = setInterval(
        drive,
        Math.max(
          CHECKOUT_WATCH_MIN_POLL_MS,
          options.pollMs ?? CHECKOUT_WATCH_DEFAULT_POLL_MS,
        ),
      );
      timer.unref?.();
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      for (const watcher of watchers.values()) watcher.stop();
    },
    canvases: () => [...watchers.keys()].sort(),
  };
};
