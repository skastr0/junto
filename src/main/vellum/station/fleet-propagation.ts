import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
} from "effect";
import { StationHostId } from "@shared/station-api";
import type { HostId } from "@shared/remote-hosts";
import {
  StationFleetTargetRepository,
  type StationFleetTargetRepositoryError,
} from "./fleet-target-repository";
import {
  StationPropagation,
  StationPropagationInvariantError,
  type StationPropagationError,
  type StationPropagationReceipt,
} from "./propagation";
import { parseSshEndpoint } from "../ssh/domain";
import { sshEndpointForHostId } from "../hosts/snapshot";

export type StationFleetPropagationResult =
  | {
      readonly ok: true;
      readonly hostId: HostId;
      readonly receipt: StationPropagationReceipt;
    }
  | {
      readonly ok: false;
      readonly hostId: HostId;
      readonly error: StationPropagationError;
    };

/**
 * One bounded fleet pass.
 *
 * A failed Remote is data in the result, not a failure of the whole pass, so
 * one offline machine cannot head-of-line block the other independently homed
 * stations. Failure to read the canonical fleet registry remains fatal.
 */
export class StationFleetPropagation extends Context.Tag(
  "@vellum/StationFleetPropagation",
)<
  StationFleetPropagation,
  {
    readonly synchronizeAll: Effect.Effect<
      ReadonlyArray<StationFleetPropagationResult>,
      StationFleetTargetRepositoryError
    >;
    /** Start the installation-local reconvergence cadence exactly once. */
    readonly start: (
      intervalMs?: number,
    ) => Effect.Effect<void>;
    /** Coalesce an authored canvas change into one near-term fleet pass. */
    readonly request: (
      delayMs?: number,
    ) => Effect.Effect<void>;
    /** Stop timers and interrupt an in-flight pass during runtime disposal. */
    readonly stop: Effect.Effect<void>;
  }
>() {}

const DEFAULT_FLEET_INTERVAL_MS = 8_000;
const DEFAULT_CHANGE_COALESCE_MS = 400;

export const StationFleetPropagationLive = Layer.scoped(
  StationFleetPropagation,
  Effect.gen(function* () {
    const targets = yield* StationFleetTargetRepository;
    const propagation = yield* StationPropagation;

    const synchronizeAll = targets.list.pipe(
      Effect.flatMap((fleet) =>
        Effect.forEach(
          fleet,
          (target) => {
            const route = sshEndpointForHostId(target.hostId);
            if (route === undefined) {
              return Effect.succeed({
                ok: false as const,
                hostId: target.hostId,
                error: StationPropagationInvariantError.make({
                  operation: "synchronize",
                  reason: "station-host-mismatch",
                  message:
                    `host ${JSON.stringify(target.hostId)} has no enrolled SSH route`,
                }),
              } satisfies StationFleetPropagationResult);
            }
            return parseSshEndpoint(route).pipe(
              Effect.mapError((error) =>
                StationPropagationInvariantError.make({
                  operation: "synchronize",
                  reason: "station-host-mismatch",
                  message: error.message,
                })
              ),
              Effect.flatMap((endpoint) =>
                propagation.synchronize({
                  endpoint,
                  stationInstallationId: target.stationInstallationId,
                  hostId: Schema.decodeUnknownSync(StationHostId)(
                    target.hostId,
                  ),
                })
              ),
              Effect.match({
                onFailure: (error): StationFleetPropagationResult => ({
                  ok: false,
                  hostId: target.hostId,
                  error,
                }),
                onSuccess: (receipt): StationFleetPropagationResult => ({
                  ok: true,
                  hostId: target.hostId,
                  receipt,
                }),
              }),
            );
          },
          { concurrency: 4 },
        )
      ),
      Effect.withSpan("station.fleet.synchronize-all"),
    );

    let interval: ReturnType<typeof setInterval> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let active:
      | Fiber.RuntimeFiber<
          ReadonlyArray<StationFleetPropagationResult>,
          StationFleetTargetRepositoryError
        >
      | undefined;
    let pending = false;
    let started = false;
    let stopped = false;

    const clearTimers = (): void => {
      if (interval !== undefined) clearInterval(interval);
      if (debounce !== undefined) clearTimeout(debounce);
      interval = undefined;
      debounce = undefined;
    };

    const launch = (): void => {
      if (stopped || !started) return;
      if (active !== undefined) {
        pending = true;
        return;
      }
      const fiber = Effect.runFork(synchronizeAll);
      active = fiber;
      fiber.addObserver((exit) => {
        if (active === fiber) active = undefined;
        if (Exit.isFailure(exit)) {
          console.error(
            "[station] fleet synchronization failed:",
            Cause.pretty(exit.cause),
          );
        } else {
          for (const result of exit.value) {
            if (result.ok) continue;
            console.error(
              `[station] ${result.hostId} synchronization failed:`,
              result.error._tag,
            );
          }
        }
        if (pending && !stopped) {
          pending = false;
          launch();
        }
      });
    };

    const start = (intervalMs = DEFAULT_FLEET_INTERVAL_MS) =>
      Effect.sync(() => {
        if (stopped || interval !== undefined) return;
        const admittedInterval = Number.isSafeInteger(intervalMs) &&
            intervalMs >= 1_000 &&
            intervalMs <= 60 * 60 * 1_000
          ? intervalMs
          : DEFAULT_FLEET_INTERVAL_MS;
        started = true;
        interval = setInterval(launch, admittedInterval);
        if (typeof interval === "object" && "unref" in interval) {
          interval.unref();
        }
        launch();
      });

    const request = (delayMs = DEFAULT_CHANGE_COALESCE_MS) =>
      Effect.sync(() => {
        if (stopped || !started) return;
        const admittedDelay = Number.isSafeInteger(delayMs) &&
            delayMs >= 0 &&
            delayMs <= 60_000
          ? delayMs
          : DEFAULT_CHANGE_COALESCE_MS;
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          launch();
        }, admittedDelay);
        if (typeof debounce === "object" && "unref" in debounce) {
          debounce.unref();
        }
      });

    const stop = Effect.gen(function* () {
      stopped = true;
      started = false;
      pending = false;
      clearTimers();
      const current = active;
      active = undefined;
      if (current !== undefined) yield* Fiber.interrupt(current);
    });

    yield* Effect.addFinalizer(() => stop);

    return StationFleetPropagation.of({
      synchronizeAll,
      start,
      request,
      stop,
    });
  }),
);
