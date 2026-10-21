/**
 * The seat-state source for automations (plan 0.10/07, runner rules owned by
 * pty): seat-state events, folded through the pure trigger machine in
 * `@shared/seat-state-trigger`, as firings an automation acts on.
 *
 * A firing names its seat by binding id (`SeatStateFiring.seat`). The runner
 * resolves it to the agent node whose `bindingId` it is, on a canvas this
 * machine edits, and drops it otherwise. A firing's `key` is unique per seat,
 * epoch, state and episode, so the runner claims it once.
 *
 * The rules: idle and working fire after holding 30 s, attention once per
 * episode, gone 60 s after its exit when no new generation takes the seat,
 * unknown never. A cache cut is invisible. A seed (a machine's current state
 * of a seat, at start or when the machine is first heard) counts as already
 * settled, so a restart fires nothing.
 *
 * The input is one stream of feeds, each tagged with the machine its seat
 * runs on: this machine's own term/agent-state, merged with the seats on
 * other machines as they cross the seats link. While the link to a machine is
 * down its seats are not heard, and silence is not gone: each one's hold or
 * gone grace ends unfired, and its next event reseeds it; a seat that went
 * meanwhile starts its gone grace then. So the gone grace counts only time
 * the link is up, and a network blip fires nothing.
 */
import { Clock, Context, Effect, Fiber, Layer, PubSub, Queue, Stream } from "effect";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { InstallationId } from "@shared/installation-id";
import {
  emptySeatTriggers,
  loseSeatTriggers,
  nextSeatTriggerDue,
  regainSeatTriggers,
  seedSeatTriggers,
  stepSeatTriggers,
  type SeatStateFiring,
  type SeatTriggerInput,
} from "@shared/seat-state-trigger";
import { MachineRepository } from "../machines/repository";
import { seatStateRuntime } from "../term/agent-state/runtime";
import { onRemoteSeatFeed, remoteSeatStateFeeds } from "../term/remote-seat-state";

export class SeatStateSource extends Context.Service<
  SeatStateSource,
  {
    /** Every firing from the moment of subscribing on, in the order they happened. */
    readonly firings: Stream.Stream<SeatStateFiring>;
  }
>()("@junto/SeatStateSource") {}

/**
 * What one machine says of its seats. A `seed` is the machine's current
 * state of a seat, settled and silent; a `live` event is folded by the rules;
 * `lost` is the link to the machine going down.
 */
export type SeatStateFeed =
  | { readonly machine: InstallationId; readonly kind: "seed" | "live"; readonly event: AgentSeatStateEvent }
  | { readonly machine: InstallationId; readonly kind: "lost" };

/** A firing goes to every subscriber; one that falls this far behind loses the oldest. */
const FIRINGS_BUFFER = 1024;

type Step = { readonly _tag: "Feed"; readonly feed: SeatStateFeed } | SeatTriggerInput;

/**
 * Fold the feeds through the trigger machine, with one timer armed at the
 * next hold or grace that comes due. Every input, feed or timer, goes through
 * one queue, so the fold sees them in one order.
 */
export const makeSeatStateSource = (feeds: Stream.Stream<SeatStateFeed>) =>
  Effect.gen(function* () {
    const firings = yield* PubSub.sliding<SeatStateFiring>(FIRINGS_BUFFER);
    const steps = yield* Queue.unbounded<Step>();
    let state = emptySeatTriggers;
    /** The machine each seat was last heard from. */
    const machineOf = new Map<string, InstallationId>();
    /** Seats whose machine's link was lost; the next event of each is its seed. */
    const unheard = new Set<string>();
    let armed: { readonly due: number; readonly fiber: Fiber.Fiber<unknown> } | undefined;

    const arm = Effect.gen(function* () {
      const due = nextSeatTriggerDue(state);
      if (due === armed?.due) return;
      if (armed !== undefined) yield* Fiber.interrupt(armed.fiber);
      armed = undefined;
      if (due === undefined) return;
      // The wait is measured when the timer starts, so a timer that starts
      // late never sleeps past its due time.
      const fiber = yield* Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (due > now) yield* Effect.sleep(due - now);
        const woke = yield* Clock.currentTimeMillis;
        yield* Queue.offer(steps, { _tag: "Tick", now: Math.max(woke, due) });
      }).pipe(Effect.forkScoped);
      armed = { due, fiber };
    });

    const fold = (input: SeatTriggerInput) =>
      Effect.gen(function* () {
        const next = stepSeatTriggers(state, input);
        state = next.state;
        if (next.firings.length > 0) yield* PubSub.publishAll(firings, next.firings);
      });

    const take = (feed: SeatStateFeed) =>
      Effect.gen(function* () {
        if (feed.kind === "lost") {
          const lost = [...machineOf].flatMap(([bindingId, machine]) => (machine === feed.machine ? [bindingId] : []));
          for (const bindingId of lost) unheard.add(bindingId);
          state = loseSeatTriggers(state, lost);
          return;
        }
        const { bindingId } = feed.event;
        machineOf.set(bindingId, feed.machine);
        if (feed.kind === "seed") {
          unheard.delete(bindingId);
          state = seedSeatTriggers([feed.event], feed.event.at, state);
        } else if (unheard.delete(bindingId)) {
          state = regainSeatTriggers(state, feed.event, yield* Clock.currentTimeMillis);
        } else {
          yield* fold({ _tag: "Event", event: feed.event });
        }
      });

    const apply = (step: Step) =>
      Effect.gen(function* () {
        if (step._tag === "Feed") yield* take(step.feed);
        else yield* fold(step);
        yield* arm;
      });

    yield* Queue.take(steps).pipe(Effect.flatMap(apply), Effect.forever, Effect.forkScoped);
    yield* feeds.pipe(
      Stream.runForEach((feed) => Queue.offer(steps, { _tag: "Feed", feed })),
      Effect.forkScoped,
    );
    return SeatStateSource.of({ firings: Stream.fromPubSub(firings) });
  });

/**
 * This machine's seats: each one's current state as a seed, then every live
 * event. Both are read in one synchronous step, so no event falls between.
 */
export const localSeatStateFeeds = (
  machine: InstallationId,
  runtime: Pick<typeof seatStateRuntime, "currentEvents" | "subscribe"> = seatStateRuntime,
): Stream.Stream<SeatStateFeed> =>
  Stream.callback<SeatStateFeed>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        for (const event of runtime.currentEvents()) Queue.offerUnsafe(queue, { machine, kind: "seed", event });
        return runtime.subscribe((event) => {
          Queue.offerUnsafe(queue, { machine, kind: "live", event });
        });
      }),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );

/**
 * The seats on other machines, as the seats link brings them to this one:
 * each one's last state as a seed, then every state and every lost link.
 */
export const remoteSeatStateFeedsOf = (
  remote: { readonly current: typeof remoteSeatStateFeeds; readonly subscribe: typeof onRemoteSeatFeed } = {
    current: remoteSeatStateFeeds,
    subscribe: onRemoteSeatFeed,
  },
): Stream.Stream<SeatStateFeed> =>
  Stream.callback<SeatStateFeed>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        for (const { machine, event } of remote.current()) Queue.offerUnsafe(queue, { machine, kind: "seed", event });
        return remote.subscribe((feed) => {
          Queue.offerUnsafe(
            queue,
            feed._tag === "Lost" ? { machine: feed.machine, kind: "lost" } : { machine: feed.machine, kind: "live", event: feed.event },
          );
        });
      }),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );

export const SeatStateSourceLive = Layer.effect(
  SeatStateSource,
  Effect.gen(function* () {
    const machines = yield* MachineRepository;
    const machine = yield* machines.installationId.pipe(Effect.orDie);
    return yield* makeSeatStateSource(Stream.merge(localSeatStateFeeds(machine), remoteSeatStateFeedsOf()));
  }),
);
