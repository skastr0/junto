// Checkout commit watch: observe new commits in bound git checkouts and turn
// the attributed ones into receipt-feed inputs. One doctrine rules the whole
// module: a watch NEVER attributes an arbitrary commit in a shared checkout
// to a seat. Attribution exists only when the observation ties to proven
// author/task checkout context — the durable claim or task-update that bound
// (checkout, seat, task). A checkout with zero bindings, or with bindings
// from more than one distinct active seat, yields unattributed observations:
// recorded, exposed, and never seat-claimed.
//
// Identity: a checkout is the canonical worktree path; a commit is its full
// sha. Duplicate observations coalesce twice — the watcher diffs against the
// last seen HEAD per checkout, and the durable plane keys
// (checkout, sha) exactly. Attach never synthesizes history: the first scan
// of a checkout records the baseline HEAD and emits nothing.

import type { ActorSeatId } from "@shared/actor-seat";

// ---------------------------------------------------------------------------
// Bindings: proven (checkout, seat, task) context.

export type CheckoutBindingVia = "claim-context" | "update-context";

export type CheckoutBinding = {
  readonly checkoutKey: string;
  readonly seatId: ActorSeatId;
  readonly taskId: string;
  readonly via: CheckoutBindingVia;
};

/**
 * The active binding set. A seat may move one binding forward (new task,
 * same checkout — the latest wins for that seat); a second distinct seat on
 * the same checkout makes the checkout ambiguous until released.
 */
export class CheckoutAttribution {
  private readonly bindings = new Map<string, Map<ActorSeatId, CheckoutBinding>>();

  bind(binding: CheckoutBinding): void {
    let perSeat = this.bindings.get(binding.checkoutKey);
    if (perSeat === undefined) {
      perSeat = new Map();
      this.bindings.set(binding.checkoutKey, perSeat);
    }
    perSeat.set(binding.seatId, binding);
  }

  release(checkoutKey: string, seatId: ActorSeatId): void {
    const perSeat = this.bindings.get(checkoutKey);
    if (perSeat === undefined) return;
    perSeat.delete(seatId);
    if (perSeat.size === 0) this.bindings.delete(checkoutKey);
  }

  /** All bindings for one task (any checkout, any seat), e.g. on re-home. */
  releaseTask(taskId: string): void {
    for (const [checkoutKey, perSeat] of this.bindings) {
      for (const [seatId, binding] of perSeat) {
        if (binding.taskId === taskId) perSeat.delete(seatId);
      }
      if (perSeat.size === 0) this.bindings.delete(checkoutKey);
    }
  }

  /**
   * The one binding an observation may attribute to: exactly one distinct
   * active seat bound to this checkout. Zero or several → undefined.
   */
  attribute(checkoutKey: string): CheckoutBinding | undefined {
    const perSeat = this.bindings.get(checkoutKey);
    if (perSeat === undefined || perSeat.size !== 1) return undefined;
    return perSeat.values().next().value!;
  }

  seatsFor(checkoutKey: string): ReadonlyArray<ActorSeatId> {
    return [...(this.bindings.get(checkoutKey)?.keys() ?? [])];
  }
}

// ---------------------------------------------------------------------------
// Observations.

export type CheckoutObservation = {
  readonly checkoutKey: string;
  readonly sha: string;
  readonly seatId?: ActorSeatId;
  readonly taskId?: string;
  readonly attributedVia?: CheckoutBindingVia;
};

export type HeadSnapshot = {
  readonly branch: string;
  readonly head: string;
};

/** Git access the watcher needs; the service injects the real adapter. */
export interface GitProbe {
  /** Current HEAD of one worktree, or undefined when it is not a git worktree. */
  head(worktree: string): Promise<HeadSnapshot | undefined>;
  /**
   * Commits reachable from `to` but not `from` (rev-list to --not from),
   * full shas, newest first.
   */
  newCommits(
    worktree: string,
    fromExclusive: string,
    toInclusive: string,
  ): Promise<ReadonlyArray<string>>;
}

export type TrackedCheckout = {
  readonly checkoutKey: string;
  readonly worktree: string;
};

/**
 * Bounded commit watcher over explicit tracked checkouts. Poll-driven
 * (packed-ref writes, rebases and worktree moves make fs watching a lie);
 * `scan` is one honest pass and is independently testable.
 */
export class CheckoutWatcher {
  private readonly attribution = new CheckoutAttribution();
  private readonly tracked = new Map<string, TrackedCheckout>();
  private readonly lastSeen = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly probe: GitProbe,
    private readonly onObservations: (
      observations: ReadonlyArray<CheckoutObservation>,
    ) => void,
  ) {}

  bindings(): CheckoutAttribution {
    return this.attribution;
  }

  /** Track a checkout (idempotent) and bind proven context when supplied. */
  track(input: TrackedCheckout, binding?: CheckoutBinding): void {
    this.tracked.set(input.checkoutKey, input);
    if (binding !== undefined) this.attribution.bind(binding);
  }

  untrack(checkoutKey: string): void {
    this.tracked.delete(checkoutKey);
    this.lastSeen.delete(checkoutKey);
  }

  /**
   * One bounded pass over tracked checkouts. Emits observations for commits
   * that arrived since the last seen HEAD; the first pass records the
   * baseline and stays silent. Attribution is decided per observation from
   * the CURRENT binding set — never retroactively.
   */
  async scan(): Promise<ReadonlyArray<CheckoutObservation>> {
    const out: CheckoutObservation[] = [];
    for (const { checkoutKey, worktree } of this.tracked.values()) {
      const head = await this.probe.head(worktree);
      if (head === undefined) continue;
      const seen = this.lastSeen.get(checkoutKey);
      this.lastSeen.set(checkoutKey, head.head);
      if (seen === undefined || seen === head.head) continue;
      const commits = await this.probe.newCommits(worktree, seen, head.head);
      if (commits.length === 0) continue;
      const binding = this.attribution.attribute(checkoutKey);
      for (const raw of commits) {
        const sha = raw.trim().toLowerCase();
        if (sha.length === 0) continue;
        out.push({
          checkoutKey,
          sha,
          ...(binding !== undefined
            ? {
                seatId: binding.seatId,
                taskId: binding.taskId,
                attributedVia: binding.via,
              }
            : {}),
        });
      }
    }
    if (out.length > 0) this.onObservations(out);
    return out;
  }

  start(pollMs: number): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.scan();
    }, Math.max(250, pollMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
