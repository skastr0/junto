/**
 * Seat wait/observe service — read-only over the seat state stream, the settled
 * observer grid, and the work mutation seam.
 *
 * Three ops live here, and every one of them is a *read*:
 *
 * - `seat.wait` subscribes to the seat state machine and returns the first
 *   authorized transition into the requested state, or a typed timeout.
 * - `seat.read` returns a bounded window of a settled observer grid, optionally
 *   following until the grid advances or the follow duration elapses.
 * - `tasks.wait` subscribes to work mutations and returns the first authorized
 *   task state change.
 *
 * Rules this module enforces, because they are the whole point of the port:
 *
 * 1. Authority is re-derived from a fresh live document before an event is
 *    accepted and before every return — including after an awaited grid read —
 *    so a long wait can never answer from an edge the operator has since
 *    removed. A canvas commit on the caller's canvas re-derives immediately,
 *    which is how a revoked edge ends a wait or a follow at once instead of at
 *    its deadline.
 * 2. Subscriptions are registered before the current value is checked, so a
 *    transition that lands during registration cannot be lost.
 * 3. Every wait and every follow is bounded, and every subscription is released
 *    on settle, timeout, revocation or interruption.
 * 4. A wait reports the seat state event as the machine published it, with its
 *    confidence and reason. It applies no readiness policy of its own: a
 *    pull-only harness with no screen rule pack legitimately sits on a
 *    low-confidence idle, and the caller decides what that is worth.
 * 5. The read port grants no write, resize, or signal operation — the only
 *    screen access here is `readWindow`, read-only by construction.
 *
 * Remote seats are out of this iteration (local Command Center only), and that
 * is enforced rather than assumed: a managed seat whose canonical delivery
 * surface is not this host is refused with `crew-local-seat-only`, because this
 * process holds no grid and no live state for it. `--any` considers only local
 * authorized peers. Nothing here falls back to a stale grid or a `gone` state
 * for a seat that runs on another machine.
 */

import { Effect, Result } from "effect";
import {
  actorDeliverySurfaceOf,
  isManagedAgentNode,
  type ManagedAgentNode,
} from "@shared/actor-surface";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { DEFAULT_STATION_HOST_ID } from "@shared/station";
import type { AgentSeatState, AgentSeatStateEvent } from "@shared/agent-seat-state";
import {
  SEAT_WAIT_DEFAULT_MS,
  TASK_WAIT_DEFAULT_MS,
  clampFollowSeconds,
  clampReadLines,
  clipReadText,
  utf8ByteLength,
  type SeatReadArgs,
  type SeatReadResult,
  type SeatWaitArgs,
  type SeatWaitResult,
  type TaskWaitArgs,
  type TaskWaitResult,
} from "@shared/seat-control";
import type { WorkErrorBody } from "@shared/work-control";
import type { ObserverGridSnapshot, ObserverGridWindow } from "../term/observer";
import {
  admitWorkTarget,
  connectedCapabilities,
  findNode,
  nodeKind,
} from "./authz";

/** The caller identity control.ts already resolved (process-bind). */
export type SeatObservationCaller = {
  readonly canvasName: string;
  readonly nodeId: string;
};

/** Terminal session witness for one binding. */
export type SeatSessionSnapshot = {
  readonly epoch: string;
  readonly status: "starting" | "running" | "exited" | "missing";
};

export type SeatObservationDeps = {
  /**
   * Live canvas document at call time. Re-read for every event and every
   * return: an authorization decision is only as good as the document it was
   * made against.
   */
  readonly readDoc: (canvasName: string) => Effect.Effect<CanvasDoc, WorkErrorBody>;
  /** Canvas commit subscription — a grant change re-derives authority. */
  readonly subscribeCanvasChanges: (listener: (canvasName: string) => void) => () => void;
  /** Seat state stream. `current` is the live projection for registration races. */
  readonly seatStates: {
    readonly current: () => ReadonlyArray<AgentSeatStateEvent>;
    readonly subscribe: (listener: (event: AgentSeatStateEvent) => void) => () => void;
  };
  /** Work mutation stream, used by `tasks.wait`. */
  readonly subscribeWorkChanges: (
    listener: (canvasName: string | undefined, nodeId: string | undefined) => void,
  ) => () => void;
  /** Current terminal generation for a binding, or undefined when none exists. */
  readonly sessionOf: (bindingId: string) => SeatSessionSnapshot | undefined;
  /** Settled read-only grid window, or undefined when no grid is live. */
  readonly readGrid: (
    bindingId: string,
    lines: number,
  ) => Promise<ObserverGridWindow | undefined>;
  /** Grid settled-write subscription, used by `seat.read --follow`. */
  readonly subscribeGrid: (listener: (snapshot: ObserverGridSnapshot) => void) => () => void;
  readonly now?: () => number;
};

export type SeatObservation = {
  readonly waitSeat: (
    args: SeatWaitArgs,
    caller: SeatObservationCaller,
  ) => Effect.Effect<SeatWaitResult, WorkErrorBody>;
  readonly readSeat: (
    args: SeatReadArgs,
    caller: SeatObservationCaller,
  ) => Effect.Effect<SeatReadResult, WorkErrorBody>;
  readonly waitTask: (
    args: TaskWaitArgs,
    caller: SeatObservationCaller,
  ) => Effect.Effect<TaskWaitResult, WorkErrorBody>;
};

// ---------------------------------------------------------------------------
// Errors

const timeoutError = (input: {
  readonly target: string;
  readonly from: string | undefined;
  readonly to: string;
  readonly waitedMs: number;
  readonly hint: string;
}): WorkErrorBody => ({
  type: "Timeout",
  message:
    input.from === undefined
      ? `wait timed out after ${input.waitedMs}ms with no "${input.to}" state observed`
      : `wait timed out after ${input.waitedMs}ms; last observed "${input.from}"`,
  details: {
    target: input.target,
    ...(input.from !== undefined ? { from: input.from } : {}),
    to: input.to,
    hint: input.hint,
    retryable: true,
    next_step: "re-issue the wait, or raise the timeout up to 600s",
  },
});

const notASeat = (targetId: string, kind: string | undefined): WorkErrorBody => ({
  type: "UnknownTarget",
  message: `target "${targetId}" is not a managed agent seat`,
  details: {
    target: targetId,
    ...(kind !== undefined ? { received: kind } : {}),
    hint: "wait and observe apply to agent nodes that own a managed terminal seat",
    retryable: false,
    next_step: "retry against an agent node on the canvas",
  },
});

const noAuthorizedPeer = (callerId: string): WorkErrorBody => ({
  type: "ScopeError",
  message: `no authorized peer seat holds the seat.wait port from "${callerId}"`,
  details: {
    caller: callerId,
    missing: "edge",
    hint: "any waits on the peer seats a drawn edge authorizes, never every seat on the machine",
    retryable: false,
    next_step: "ask the operator to draw a messages edge to the peer seat, then retry",
  },
});

const noLiveGrid = (targetId: string): WorkErrorBody => ({
  type: "UnknownTarget",
  message: `seat "${targetId}" has no live terminal grid to follow`,
  details: {
    target: targetId,
    hint: "the seat has no live screen to observe in this generation",
    retryable: true,
    next_step: "start the seat's terminal, then retry the follow",
  },
});

/**
 * A managed seat that runs on another host. This Command Center holds no grid
 * and no live seat state for it, so a wait or read is refused up front rather
 * than answered from a stale local projection.
 */
const remoteSeatOnly = (targetId: string, hostId: string): WorkErrorBody => ({
  type: "ScopeError",
  message: `seat "${targetId}" runs on host "${hostId}"; this Command Center observes local seats only`,
  details: {
    target: targetId,
    received: hostId,
    reason: "crew-local-seat-only",
    hint: "wait and observe are local-iteration operations; another host's screen is not on this machine",
    retryable: false,
    next_step: "run the wait or read from the Command Center that hosts that seat",
  },
});

/** No authorized peer runs locally, though authorized peers exist elsewhere. */
const noLocalAuthorizedPeer = (callerId: string, remoteCount: number): WorkErrorBody => ({
  type: "ScopeError",
  message: `${remoteCount} authorized peer seat(s) run on another host; none run on this Command Center`,
  details: {
    caller: callerId,
    reason: "crew-local-seat-only",
    hint: "any waits on the local peer seats a drawn edge authorizes, never a seat on another machine",
    retryable: false,
    next_step: "run the wait from the Command Center that hosts those seats",
  },
});

// ---------------------------------------------------------------------------
// Subscription helpers

/**
 * The first value a subscription delivers that `select` accepts.
 *
 * Registration happens inside the callback, so callers that race this against a
 * current-value check get the ordering the contract demands: subscribe first,
 * then look. The abort listener releases the subscription on interruption, so a
 * cancelled wait cannot leave a listener behind.
 */
const awaitSelected = <A>(
  subscribe: (listener: (value: A) => void) => () => void,
  select: (value: A) => boolean,
): Effect.Effect<A> =>
  Effect.callback<A>((resume, signal) => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const stop = (): void => {
      if (!active) return;
      active = false;
      const off = unsubscribe;
      unsubscribe = undefined;
      try {
        off?.();
      } catch {
        // A throwing unsubscribe must not retain the waiter.
      }
    };
    const onValue = (value: A): void => {
      if (!active || !select(value)) return;
      stop();
      resume(Effect.succeed(value));
    };
    try {
      const off = subscribe(onValue);
      if (active) unsubscribe = off;
      else {
        // A synchronous replay may have settled us during subscribe.
        try {
          off();
        } catch {
          // Already settled.
        }
      }
    } catch {
      // A subscription that refuses to register can never deliver; the
      // deadline racer still bounds the caller.
    }
    signal.addEventListener("abort", stop, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", stop);
      stop();
    });
  });

/** Sleep until an absolute deadline (0 when it has already passed). */
const sleepUntil = (deadlineAt: number, now: () => number): Effect.Effect<void> =>
  Effect.sleep(Math.max(0, deadlineAt - now()));

// ---------------------------------------------------------------------------
// Seat targets

type SeatTarget = {
  readonly nodeId: string;
  readonly bindingId: string;
};

const seatTargetOf = (node: ManagedAgentNode): SeatTarget => ({
  nodeId: node.id,
  bindingId: node.ether.terminal.bindingId,
});

/**
 * Whether this managed seat runs on this Command Center.
 *
 * The canonical delivery surface carries the host, and it is the same witness
 * the delivery path uses to decide which machine owns the PTY. A seat on
 * another host has no grid and no live state here, so it is not observable.
 */
const isLocalSeat = (node: ManagedAgentNode): boolean =>
  actorDeliverySurfaceOf(node)?.hostId === DEFAULT_STATION_HOST_ID;

/** The host a managed seat's canonical surface names, for the refusal message. */
const seatHostOf = (node: CanvasNode): string =>
  actorDeliverySurfaceOf(node)?.hostId ?? DEFAULT_STATION_HOST_ID;

/**
 * Resolve the seats a wait may address under current authority.
 *
 * An explicit target must hold the port on the caller's edge and run locally;
 * `any` is every connected actor node whose edge holds the port and that runs
 * locally. The caller is never a candidate for `any` — a seat waiting on itself
 * would always succeed.
 */
const resolveSeatTargets = (
  doc: CanvasDoc,
  callerId: string,
  args: Pick<SeatWaitArgs, "target" | "any">,
): Result.Result<ReadonlyArray<SeatTarget>, WorkErrorBody> => {
  if (args.target !== undefined) {
    const admitted = admitWorkTarget(doc, callerId, args.target, "seat.wait");
    if (Result.isFailure(admitted)) return Result.fail(admitted.failure);
    const node = admitted.success.node;
    if (!isManagedAgentNode(node)) {
      return Result.fail(notASeat(args.target, nodeKind(node)));
    }
    if (!isLocalSeat(node)) {
      return Result.fail(remoteSeatOnly(args.target, seatHostOf(node)));
    }
    return Result.succeed([seatTargetOf(node)]);
  }
  const authorized = connectedCapabilities(doc, callerId)
    .filter((peer) => peer.role === "actor" && peer.grants.includes("seat.wait"))
    .map((peer) => findNode(doc, peer.id))
    .filter((node): node is ManagedAgentNode => node !== undefined && isManagedAgentNode(node));
  if (authorized.length === 0) return Result.fail(noAuthorizedPeer(callerId));
  const local = authorized.filter(isLocalSeat).map(seatTargetOf);
  if (local.length === 0) {
    return Result.fail(noLocalAuthorizedPeer(callerId, authorized.length));
  }
  return Result.succeed(local);
};

/** One explicit read target: same authority and locality rule, port `terminal.read`. */
const resolveReadTarget = (
  doc: CanvasDoc,
  callerId: string,
  targetId: string,
): Result.Result<SeatTarget, WorkErrorBody> => {
  const admitted = admitWorkTarget(doc, callerId, targetId, "seat.read");
  if (Result.isFailure(admitted)) return Result.fail(admitted.failure);
  const node = admitted.success.node;
  if (!isManagedAgentNode(node)) {
    return Result.fail(notASeat(targetId, nodeKind(node)));
  }
  if (!isLocalSeat(node)) {
    return Result.fail(remoteSeatOnly(targetId, seatHostOf(node)));
  }
  return Result.succeed(seatTargetOf(node));
};

const seatStateOf = (
  events: ReadonlyArray<AgentSeatStateEvent>,
  bindingId: string,
): AgentSeatStateEvent | undefined =>
  events.find((event) => event.bindingId === bindingId);

/**
 * Whether two authorized target sets are the same set of seats.
 *
 * Compared by binding, order-insensitively: a re-derived set that names the
 * same seats is not a change, while a seat added or removed is — and the wait
 * must rebuild its subscriptions on the fresh set rather than keep watching a
 * set the operator has already redrawn.
 */
const sameSeatTargets = (
  left: ReadonlyArray<SeatTarget>,
  right: ReadonlyArray<SeatTarget>,
): boolean => {
  if (left.length !== right.length) return false;
  const key = (targets: ReadonlyArray<SeatTarget>): string =>
    targets
      .map((target) => `${target.nodeId}\u0000${target.bindingId}`)
      .sort()
      .join("\u0001");
  return key(left) === key(right);
};

// ---------------------------------------------------------------------------
// The service

export const makeSeatObservation = (deps: SeatObservationDeps): SeatObservation => {
  const now = deps.now ?? (() => Date.now());

  /** The wire result for one seat state event, stamped with its generation. */
  const resultFromEvent = (target: SeatTarget, event: AgentSeatStateEvent): SeatWaitResult => {
    const session = deps.sessionOf(target.bindingId);
    return {
      target: target.nodeId,
      state: event.state,
      reason: event.reason,
      confidence: event.confidence,
      generation: session?.epoch ?? event.epoch,
      epoch: event.epoch,
      at: event.at,
    };
  };

  /** Whether a state event belongs to the binding's current generation. */
  const eventIsLive = (bindingId: string, epoch: string): boolean => {
    const session = deps.sessionOf(bindingId);
    return session === undefined || session.epoch === epoch;
  };

  /**
   * The seat's current observation, with whether it belongs to the live
   * generation.
   *
   * A late event from a replaced generation is not an observation of the seat
   * that exists now: it is retained only to explain a timeout, never to answer
   * a wait.
   */
  const observeSeat = (
    target: SeatTarget,
  ): { readonly result: SeatWaitResult; readonly live: boolean } | undefined => {
    const event = seatStateOf(deps.seatStates.current(), target.bindingId);
    if (event === undefined) return undefined;
    return { result: resultFromEvent(target, event), live: eventIsLive(target.bindingId, event.epoch) };
  };

  /**
   * Whether an observation answers a wait for `until`.
   *
   * The wait reports the seat state event as the machine published it — state,
   * confidence and reason — and applies no readiness policy of its own.
   */
  const matchesUntil = (
    observation: { readonly result: SeatWaitResult; readonly live: boolean } | undefined,
    until: AgentSeatState,
  ): boolean =>
    observation !== undefined && observation.live && observation.result.state === until;

  /** The same generation witness, for an event that arrived by subscription. */
  const waitSeat = (
    args: SeatWaitArgs,
    caller: SeatObservationCaller,
  ): Effect.Effect<SeatWaitResult, WorkErrorBody> =>
    Effect.gen(function* () {
      const timeoutMs = args.timeoutMs ?? SEAT_WAIT_DEFAULT_MS;
      const deadlineAt = now() + timeoutMs;
      let last: SeatWaitResult | undefined;
      let lastStale: SeatWaitResult | undefined;

      type Signal =
        | { readonly _tag: "matched"; readonly event: AgentSeatStateEvent }
        | { readonly _tag: "canvas" }
        | { readonly _tag: "deadline" };

      /**
       * Re-derive authority now that the canvas subscription is installed, and
       * notice a redrawn authorized set.
       *
       * This closes two gaps the subscription alone cannot. A grant removed
       * after the loop's own read but before this registration would otherwise
       * ride to the deadline instead of failing closed; and an authorized set
       * that changed (a peer added or removed) would leave the loop watching
       * seats the operator has already redrawn — so a newly authorized seat
       * that is *already* in the requested state would be waited on forever.
       */
      const recheckAuthority = (
        captured: ReadonlyArray<SeatTarget>,
      ): Effect.Effect<Signal, WorkErrorBody> =>
        Effect.suspend(() =>
          Effect.gen(function* () {
            const fresh = yield* deps.readDoc(caller.canvasName);
            const freshTargets = resolveSeatTargets(fresh, caller.nodeId, args);
            if (Result.isFailure(freshTargets)) return yield* Effect.fail(freshTargets.failure);
            if (sameSeatTargets(captured, freshTargets.success)) {
              return yield* Effect.never as Effect.Effect<Signal, WorkErrorBody>;
            }
            // The set moved: rebuild subscriptions and the current-value scan
            // on the fresh set, keeping the original deadline.
            return { _tag: "canvas" } as Signal;
          }),
        );

      // Only a canvas grant change re-enters the loop: every other signal
      // either answers, fails, or expires.
      for (;;) {
        const doc = yield* deps.readDoc(caller.canvasName);
        const targets = resolveSeatTargets(doc, caller.nodeId, args);
        if (Result.isFailure(targets)) return yield* Effect.fail(targets.failure);
        const byBinding = new Map(
          targets.success.map((target) => [target.bindingId, target] as const),
        );
        for (const target of targets.success) {
          const observation = observeSeat(target);
          if (observation === undefined) continue;
          if (observation.live) last = observation.result;
          else lastStale = observation.result;
        }

        const eventSignal: Effect.Effect<Signal, WorkErrorBody> = awaitSelected(
          deps.seatStates.subscribe,
          (event: AgentSeatStateEvent) => {
            const target = byBinding.get(event.bindingId);
            return target !== undefined && event.state === args.until;
          },
        ).pipe(Effect.map((event): Signal => ({ _tag: "matched", event })));

        // Runs after the subscription above is registered, so a transition
        // that landed during registration is still observed.
        const currentSignal: Effect.Effect<Signal, WorkErrorBody> = Effect.suspend(() => {
          const match = targets.success.find((target) =>
            matchesUntil(observeSeat(target), args.until),
          );
          if (match === undefined) return Effect.never;
          const event = seatStateOf(deps.seatStates.current(), match.bindingId);
          return event === undefined
            ? Effect.never
            : Effect.succeed<Signal>({ _tag: "matched", event });
        });

        const canvasSignal: Effect.Effect<Signal, WorkErrorBody> = awaitSelected(
          deps.subscribeCanvasChanges,
          (name: string) => name === caller.canvasName,
        ).pipe(Effect.map((): Signal => ({ _tag: "canvas" })));

        const deadlineSignal: Effect.Effect<Signal, WorkErrorBody> = sleepUntil(
          deadlineAt,
          now,
        ).pipe(Effect.map((): Signal => ({ _tag: "deadline" })));

        const signal = yield* Effect.raceFirst(
          Effect.raceFirst(eventSignal, currentSignal),
          Effect.raceFirst(
            canvasSignal,
            Effect.raceFirst(recheckAuthority(targets.success), deadlineSignal),
          ),
        );

        if (signal._tag === "deadline") {
          return yield* Effect.fail(
            timeoutError({
              target: args.target ?? "any",
              from: last?.state,
              to: args.until,
              waitedMs: timeoutMs,
              hint: timeoutHint(last, lastStale),
            }),
          );
        }
        if (signal._tag === "canvas") continue;

        // Revalidate against a fresh document before answering: the event may
        // have been produced under an edge the operator has already removed.
        const fresh = yield* deps.readDoc(caller.canvasName);
        const freshTargets = resolveSeatTargets(fresh, caller.nodeId, args);
        if (Result.isFailure(freshTargets)) return yield* Effect.fail(freshTargets.failure);
        const stillAuthorized = freshTargets.success.find(
          (target) => target.bindingId === signal.event.bindingId,
        );
        if (stillAuthorized === undefined) {
          // `any` lost this peer mid-wait: keep waiting on the rest.
          continue;
        }
        const observed = resultFromEvent(stillAuthorized, signal.event);
        if (!eventIsLive(signal.event.bindingId, signal.event.epoch)) {
          lastStale = observed;
          continue;
        }
        if (observed.state !== args.until) {
          // The seat moved on before we could answer.
          last = observed;
          continue;
        }
        return observed;
      }
    });

  const readSeat = (
    args: SeatReadArgs,
    caller: SeatObservationCaller,
  ): Effect.Effect<SeatReadResult, WorkErrorBody> =>
    Effect.gen(function* () {
      const lines = clampReadLines(args.lines);
      const follow = args.follow === true;
      const maxSeconds = clampFollowSeconds(args.maxSeconds);
      const deadlineAt = now() + maxSeconds * 1_000;

      /** Re-derive authority from the live document, or fail ScopeError. */
      const authorize = (): Effect.Effect<SeatTarget, WorkErrorBody> =>
        Effect.gen(function* () {
          const doc = yield* deps.readDoc(caller.canvasName);
          const resolved = resolveReadTarget(doc, caller.nodeId, args.target);
          if (Result.isFailure(resolved)) return yield* Effect.fail(resolved.failure);
          return resolved.success;
        });

      let target = yield* authorize();

      const windowNow = (): Effect.Effect<ObserverGridWindow | undefined, WorkErrorBody> =>
        Effect.tryPromise({
          try: () => deps.readGrid(target.bindingId, lines),
          catch: (error): WorkErrorBody => ({
            type: "InternalError",
            message:
              error instanceof Error ? error.message : "the observer grid could not be read",
            details: { retryable: true },
          }),
        });

      const build = (
        window: ObserverGridWindow | undefined,
        stopped: SeatReadResult["stopped"],
        empty: boolean,
        replacedOverride?: boolean,
      ): SeatReadResult => {
        const session = deps.sessionOf(target.bindingId);
        const seat = seatStateOf(deps.seatStates.current(), target.bindingId);
        const clip = clipReadText(empty ? [] : (window?.lines ?? []));
        const text = clip.lines.join("\n");
        // The window names the generation its bytes came from. When the seat
        // has already moved to another generation, the text belongs to the
        // window's generation — never relabeled as the new session's.
        const windowEpoch =
          window !== undefined && window.epoch.length > 0 ? window.epoch : undefined;
        const generation = windowEpoch ?? session?.epoch ?? "";
        const seatDescribesWindow =
          windowEpoch === undefined ||
          (seat !== undefined
            ? seat.epoch === windowEpoch
            : session === undefined || session.epoch === windowEpoch);
        const cursorReplaced =
          windowEpoch !== undefined &&
          args.sinceGeneration !== undefined &&
          windowEpoch !== args.sinceGeneration;
        const seatReplaced =
          windowEpoch !== undefined &&
          session !== undefined &&
          session.epoch !== windowEpoch;
        return {
          target: target.nodeId,
          state: seatDescribesWindow
            ? (seat?.state ?? (window === undefined ? "gone" : "unknown"))
            : "unknown",
          reason: seatDescribesWindow
            ? (seat?.reason ?? (window === undefined ? "no_live_grid" : "no_seat_state"))
            : "generation_replaced",
          confidence: seatDescribesWindow ? (seat?.confidence ?? "low") : "low",
          epoch: windowEpoch ?? "",
          generation,
          replaced: replacedOverride ?? (cursorReplaced || seatReplaced),
          seq: window === undefined ? 0 : Number(window.seq),
          text,
          lineCount: clip.lines.length,
          bytes: utf8ByteLength(text),
          truncated: !empty && (clip.truncated || (window?.truncated ?? false)),
          stopped,
        };
      };

      const first = yield* windowNow();

      if (!follow) {
        // A single read returns grid text, so it re-derives authority after the
        // awaited read rather than only before it.
        yield* authorize();
        return build(first, "not-following", cursorIsCurrent(args, first));
      }
      if (first === undefined) return yield* Effect.fail(noLiveGrid(target.nodeId));
      if (args.sinceGeneration !== undefined && first.epoch !== args.sinceGeneration) {
        // A replacement is explicit: the caller's cursor died with the old
        // generation, so this is the new stream's first window.
        yield* authorize();
        return build(first, "replaced", false, true);
      }
      const startSeq = args.since ?? Number(first.seq);

      type FollowSignal =
        | { readonly _tag: "advanced" | "replaced" }
        | { readonly _tag: "canvas" }
        | { readonly _tag: "duration" };

      for (;;) {
        // Re-resolve the target every iteration: a re-seat changes the node's
        // binding, and the follow must read the seat that exists now — the
        // epoch comparison below then reports the replacement explicitly.
        target = yield* authorize();

        // Subscribe before reading the current grid, so a write that lands
        // during registration is observed rather than waited past.
        const advancement: Effect.Effect<FollowSignal, WorkErrorBody> = awaitSelected(
          deps.subscribeGrid,
          (snapshot: ObserverGridSnapshot) =>
            snapshot.bindingId === target.bindingId &&
            (snapshot.epoch !== first.epoch || Number(snapshot.seq) > startSeq),
        ).pipe(
          Effect.map(
            (snapshot): FollowSignal => ({
              _tag: snapshot.epoch !== first.epoch ? "replaced" : "advanced",
            }),
          ),
        );

        const currentSignal: Effect.Effect<FollowSignal, WorkErrorBody> = Effect.suspend(() =>
          windowNow().pipe(
            Effect.flatMap((window): Effect.Effect<FollowSignal, WorkErrorBody> => {
              if (window === undefined) return Effect.never;
              if (window.epoch !== first.epoch) return Effect.succeed({ _tag: "replaced" });
              if (Number(window.seq) > startSeq) return Effect.succeed({ _tag: "advanced" });
              return Effect.never;
            }),
          ),
        );

        const revocation: Effect.Effect<FollowSignal, WorkErrorBody> = Effect.raceFirst(
          awaitSelected(
            deps.subscribeCanvasChanges,
            (name: string) => name === caller.canvasName,
          ).pipe(Effect.map((): FollowSignal => ({ _tag: "canvas" }))),
          // Re-derive authority now that the subscription is installed: a grant
          // removed before this registration would otherwise let the follow run
          // out its whole duration before the return-path check noticed.
          Effect.suspend(() =>
            Effect.gen(function* () {
              const fresh = yield* deps.readDoc(caller.canvasName);
              const reauthorized = resolveReadTarget(fresh, caller.nodeId, args.target);
              if (Result.isFailure(reauthorized)) {
                return yield* Effect.fail(reauthorized.failure);
              }
              return yield* Effect.never as Effect.Effect<FollowSignal, WorkErrorBody>;
            }),
          ),
        );

        const expiry: Effect.Effect<FollowSignal, WorkErrorBody> = sleepUntil(
          deadlineAt,
          now,
        ).pipe(Effect.map((): FollowSignal => ({ _tag: "duration" })));

        const signal = yield* Effect.raceFirst(
          Effect.raceFirst(advancement, currentSignal),
          Effect.raceFirst(revocation, expiry),
        );

        if (signal._tag === "canvas") {
          // A removed edge ends the follow now, not at the deadline: this
          // fails ScopeError before any further grid text is returned.
          yield* authorize();
          continue;
        }

        const settled = yield* windowNow();
        if (settled === undefined) return yield* Effect.fail(noLiveGrid(target.nodeId));
        yield* authorize();
        // The final settled read is the truth: a generation that replaced
        // between the signal and this read is reported as a replacement, and
        // the override only ever asserts `true` — never overwrites the
        // cursor-derived replacement with `false`.
        const replacedNow =
          settled.epoch !== first.epoch ||
          (args.sinceGeneration !== undefined && settled.epoch !== args.sinceGeneration);
        return build(
          settled,
          replacedNow ? "replaced" : signal._tag,
          false,
          replacedNow ? true : undefined,
        );
      }
    });

  const waitTask = (
    args: TaskWaitArgs,
    caller: SeatObservationCaller,
  ): Effect.Effect<TaskWaitResult, WorkErrorBody> =>
    Effect.gen(function* () {
      const timeoutMs = args.timeoutMs ?? TASK_WAIT_DEFAULT_MS;
      const deadlineAt = now() + timeoutMs;
      let last: TaskWaitResult | undefined;

      const observe = (): Effect.Effect<TaskWaitResult, WorkErrorBody> =>
        Effect.gen(function* () {
          const doc = yield* deps.readDoc(caller.canvasName);
          const admitted = admitWorkTarget(doc, caller.nodeId, args.target, "tasks.wait");
          if (Result.isFailure(admitted)) return yield* Effect.fail(admitted.failure);
          const node = admitted.success.node;
          const items = node.ether?.tasks?.items ?? node.ether?.requests?.items ?? [];
          const task = items.find((candidate) => candidate.id === args.taskId);
          if (task === undefined) {
            return yield* Effect.fail<WorkErrorBody>({
              type: "UnknownTarget",
              message: `task "${args.taskId}" is not on "${args.target}"`,
              details: {
                target: args.target,
                received: args.taskId,
                retryable: false,
                next_step: "list the sink's tasks and retry with a current task id",
              },
            });
          }
          return {
            taskId: task.id,
            state: task.state,
            epoch: task.epoch ?? 0,
            at: now(),
          };
        });

      type Signal =
        | { readonly _tag: "observed"; readonly value: TaskWaitResult }
        | { readonly _tag: "change" }
        | { readonly _tag: "canvas" }
        | { readonly _tag: "deadline" };

      for (;;) {
        // Fast path: an already-satisfied task answers without waiting a tick.
        // It is also the last observed state, which the timeout reports.
        const current = yield* observe();
        last = current;
        if (current.state === args.until) return current;

        const changeSignal: Effect.Effect<Signal, WorkErrorBody> = awaitSelected(
          deps.subscribeWorkChanges,
          (canvasName: string | undefined) =>
            canvasName === undefined || canvasName === caller.canvasName,
        ).pipe(Effect.map((): Signal => ({ _tag: "change" })));

        // A task edge can be revoked without any work mutation, so the wait
        // also watches the canvas: the re-observation below then fails
        // ScopeError at once instead of riding to the deadline.
        const canvasSignal: Effect.Effect<Signal, WorkErrorBody> = awaitSelected(
          deps.subscribeCanvasChanges,
          (name: string) => name === caller.canvasName,
        ).pipe(Effect.map((): Signal => ({ _tag: "canvas" })));

        // Runs after both subscriptions are registered: a state that moved
        // during registration is still observed.
        const matchSignal: Effect.Effect<Signal, WorkErrorBody> = Effect.suspend(() =>
          observe().pipe(
            Effect.flatMap((value): Effect.Effect<Signal, WorkErrorBody> =>
              value.state === args.until
                ? Effect.succeed({ _tag: "observed", value })
                : Effect.never,
            ),
          ),
        );

        const deadlineSignal: Effect.Effect<Signal, WorkErrorBody> = sleepUntil(
          deadlineAt,
          now,
        ).pipe(Effect.map((): Signal => ({ _tag: "deadline" })));

        const signal = yield* Effect.raceFirst(
          Effect.raceFirst(changeSignal, canvasSignal),
          Effect.raceFirst(matchSignal, deadlineSignal),
        );

        if (signal._tag === "deadline") {
          return yield* Effect.fail(
            timeoutError({
              target: args.taskId,
              from: last.state,
              to: args.until,
              waitedMs: timeoutMs,
              hint: `task ${last.taskId} is at epoch ${last.epoch}`,
            }),
          );
        }
        if (signal._tag === "observed") return signal.value;
        // A change or a grant change re-observes, which re-derives authority.
      }
    });

  return { waitSeat, readSeat, waitTask };
};

/** Why a timeout reports what it does, including an untrusted stale event. */
const timeoutHint = (
  last: SeatWaitResult | undefined,
  stale: SeatWaitResult | undefined,
): string => {
  if (last !== undefined) return `${last.confidence} confidence: ${last.reason}`;
  if (stale !== undefined) {
    return `the last state event (${stale.state}, generation ${stale.epoch}) belongs to a replaced generation and was not answered`;
  }
  return "no state event was observed for the authorized seats";
};

/**
 * Whether a caller-supplied cursor is already current: nothing new has settled
 * since it, so a plain read answers with an empty window rather than repeating
 * output the caller has already consumed.
 */
const cursorIsCurrent = (
  args: SeatReadArgs,
  window: ObserverGridWindow | undefined,
): boolean =>
  window !== undefined &&
  args.since !== undefined &&
  args.sinceGeneration !== undefined &&
  window.epoch === args.sinceGeneration &&
  Number(window.seq) <= args.since;
