/**
 * The seat-awareness plane's one life, in the core.
 *
 * The plane (`seat-awareness.ts`) reads a seat's own window and publishes an
 * advisory assessment the window draws. Its two ports are the seat-state
 * runtime and the terminal observer plane, and both live in the core process
 * alone, so the core starts the plane and publishes what it says. Main used to
 * start it, subscribed to empty copies of both ports, and so observed no seats
 * at all (0.11.7).
 *
 * Two things move it: the settings as the core starts, and each settings change
 * after. The gate is the operator's toggle plus the dev override; a discovered
 * key is not consent. Nothing here touches the terminal path or a delivery
 * decision: the rule engine alone decides whether a seat may be typed into.
 */
import { Context, Effect, Layer, Queue, Schema } from "effect";
import { SEAT_AWARENESS_COMPILED } from "@shared/features";
import { IPC_CHANNELS } from "@shared/ipc";
import type { Settings } from "@shared/settings";
import type { SeatAwarenessEvent } from "@renderer/lib/seat-awareness-contract";
import { publish } from "../../core-process/push";
import { SettingsService } from "../settings/service";
import {
  SEAT_AWARENESS_ENV,
  resolveSeatAwarenessGate,
  seatAwarenessApiKey,
  seatAwarenessEnrolled,
  seatAwarenessPlane,
  type SeatAwarenessPlane,
} from "./seat-awareness";

/** What the window reads of the plane: the live gate, and the latest event per binding. */
export type SeatAwarenessSnapshot = {
  readonly enabled: boolean;
  readonly events: ReadonlyArray<SeatAwarenessEvent>;
};

/** The plane as the core answers for it: the snapshot a renderer hydrates from, and the gate. */
export class SeatAwareness extends Context.Service<
  SeatAwareness,
  {
    readonly snapshot: () => Effect.Effect<SeatAwarenessSnapshot>;
  }
>()("@junto/SeatAwareness") {}

/** The plane could not start. The feature stays off and the core keeps running. */
export class SeatAwarenessDidNotStart extends Schema.TaggedError<SeatAwarenessDidNotStart>()(
  "SeatAwarenessDidNotStart",
  { message: Schema.String },
) {}

/**
 * One settings value against the gate: off stops the plane, on starts it, and
 * the same answer twice changes nothing. Off is the plane not running at all,
 * so nothing is observed and nothing is published for a feature the operator
 * turned off.
 */
const applyGate =
  (plane: SeatAwarenessPlane) =>
  (settings: Settings): Effect.Effect<void, SeatAwarenessDidNotStart> =>
    Effect.gen(function* () {
      if (!SEAT_AWARENESS_COMPILED) return;
      const on = resolveSeatAwarenessGate({
        env: process.env[SEAT_AWARENESS_ENV],
        enrolled: seatAwarenessEnrolled(settings),
      }).enabled;
      if (on === plane.isEnabled()) return;
      plane.stop();
      if (!on) return;
      yield* Effect.try({
        try: () => plane.start({ enabled: true, apiKey: seatAwarenessApiKey() }),
        catch: (cause) =>
          new SeatAwarenessDidNotStart({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
    });

export type SeatAwarenessLayerOptions = {
  /** Test seam: the plane to run. Production runs the process's one plane. */
  readonly plane?: SeatAwarenessPlane | undefined;
};

/**
 * The plane, started with the settings as the core finds them and moved by each
 * change after, for as long as the layer's scope lives. Every event it publishes
 * is a core push, which main relays to the window.
 */
export const makeSeatAwarenessLive = (
  options: SeatAwarenessLayerOptions = {},
): Layer.Layer<SeatAwareness, never, SettingsService> =>
  // `Layer.effect` builds this in the layer's own scope, so the finalizer below
  // and the fibers forked beside it live and die with the core's runtime.
  Layer.effect(
    SeatAwareness,
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      const plane = options.plane ?? seatAwarenessPlane;
      const gates = yield* Queue.unbounded<Settings>();
      const events = yield* Queue.unbounded<SeatAwarenessEvent>();
      const stopSettings = settings.subscribe((next) => Queue.offerUnsafe(gates, next));
      const stopEvents = plane.subscribe((event) => Queue.offerUnsafe(events, event));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopSettings();
          stopEvents();
          plane.stop();
        }),
      );
      const applied = (settings: Settings) =>
        applyGate(plane)(settings).pipe(
          Effect.catchTag("SeatAwarenessDidNotStart", (failure) =>
            Effect.logWarning(`seat awareness did not start: ${failure.message}`),
          ),
        );
      // The operator's toggle, one change at a time, in the order they arrived.
      yield* Queue.take(gates).pipe(
        Effect.flatMap(applied),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* Queue.take(events).pipe(
        Effect.flatMap((event) => Effect.sync(() => publish(IPC_CHANNELS.seatAwarenessChanged, event))),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* settings.get.pipe(
        Effect.mapError((failure) => new SeatAwarenessDidNotStart({ message: failure.message })),
        Effect.flatMap(applied),
        Effect.catchTag("SeatAwarenessDidNotStart", (failure) =>
          Effect.logWarning(`seat awareness did not read the settings: ${failure.message}`),
        ),
      );
      return SeatAwareness.of({
        snapshot: () =>
          Effect.sync(() => ({ enabled: plane.isEnabled(), events: plane.currentEvents() })),
      });
    }),
  );

/** The plane as the core runs it: one per core, from its settings. */
export const SeatAwarenessLive = makeSeatAwarenessLive();
