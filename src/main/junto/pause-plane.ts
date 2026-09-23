import { Context, Effect, Result, Layer, Ref, Schema, Semaphore } from "effect";
import { PAUSED_CANVAS, type CanvasPauseState, type PauseChangeListener, type PauseScope } from "@shared/pause";
import { FactoryPauseRepository } from "./pause/repository";

// Factory pause plane — the safety switch that decides whether the factory
// may act at all. App-state, never the document: definitions travel with the
// file; the switch that spends real actions exists only in the running app,
// flipped by a human.
//
// LAW (enforced here and in @shared/pause): a canvas with no recorded play
// decision is PAUSED. The factory is born paused; the first play is an
// explicit operator confirmation (everPlayed is the latch the UI reads).
//
// Fail closed, fail loud: unreadable SQLite state leaves every canvas paused
// and refuses writes so corrupt state is never clobbered.
//
// LAUNCH (Command Center): every launch comes back paused. A canvas left
// playing would otherwise start agent seats before the operator did anything,
// and macOS names Junto on whatever those agents read. Play is re-pressed once
// per launch; everPlayed survives, so no first-play confirmation repeats.

/** A pause state mutation that could not land durably. */
export class PauseStateError extends Schema.TaggedError<PauseStateError>()(
  "PauseStateError",
  { message: Schema.String },
) {}

export class PausePlane extends Context.Service<PausePlane,
  {
    /** Hydrate from normalized SQLite state. Idempotent. */
    readonly start: Effect.Effect<void>;
    /** Sync hot read — unknown canvas is the born-paused default. */
    readonly stateFor: (canvas: string) => CanvasPauseState;
    /** Canvas play/pause. Playing stamps everPlayed. Store-first. */
    readonly setPlaying: (
      canvas: string,
      playing: boolean,
    ) => Effect.Effect<void, PauseStateError>;
    /** Node/region pause. Canvas scope routes to setPlaying(!paused). */
    readonly setScopePaused: (
      canvas: string,
      scope: PauseScope,
      paused: boolean,
    ) => Effect.Effect<void, PauseStateError>;
    readonly subscribe: (listener: PauseChangeListener) => () => void;
  }>()("junto/PausePlane") {}

/**
 * Harness double: everything playing, writes accepted but inert. For suites
 * and acceptance scripts exercising OTHER planes (transport, authz, arming) —
 * never for pause-behavior tests.
 */
export const PausePlaneAllPlaying = Layer.succeed(PausePlane, {
  start: Effect.void,
  stateFor: () => ({ playing: true, everPlayed: true, pausedNodes: [], pausedRegions: [] }),
  setPlaying: () => Effect.void,
  setScopePaused: () => Effect.void,
  subscribe: () => () => {},
});

type PlaneMemory = {
  readonly hydrated: boolean;
  readonly canvases: ReadonlyMap<string, CanvasPauseState>;
  /** Set when SQLite could not be read at hydration — every write refuses. */
  readonly fault: string | undefined;
};

export interface PausePlaneOptions {
  /**
   * Restore a canvas's recorded play state at start. False pauses every
   * playing canvas durably before any reader sees it (the Command Center
   * launch law); true keeps the record (headless Remote stations, suites).
   */
  readonly resumePlayAtLaunch: boolean;
}

export const makePausePlaneLive = (options: PausePlaneOptions) => Layer.effect(
  PausePlane,
  Effect.gen(function* () {
    const repository = yield* FactoryPauseRepository;
    const memory = yield* Ref.make<PlaneMemory>({
      hydrated: false,
      canvases: new Map(),
      fault: undefined,
    });
    const listeners = yield* Ref.make<ReadonlySet<PauseChangeListener>>(new Set());
    // One permit preserves listener/memory ordering across concurrent writes.
    // Each repository operation is already one normalized SQLite transaction.
    const persistLock = yield* Semaphore.make(1);

    const start = Effect.gen(function* () {
      const alreadyHydrated = yield* Ref.modify(
        memory,
        (current) => [current.hydrated, { ...current, hydrated: true }] as const,
      );
      if (alreadyHydrated) return;
      const read = yield* Effect.result(repository.loadAll);
      if (Result.isFailure(read)) {
        const fault = `pause state unreadable: ${read.failure.message}`;
        yield* Effect.sync(() =>
          console.error(`[pause] ${fault} — every canvas reads paused; writes refused`),
        );
        yield* Ref.update(memory, (current) => ({ ...current, fault }));
        return;
      }
      let canvases = read.success;
      if (!options.resumePlayAtLaunch) {
        const held = new Map(canvases);
        for (const [canvas, state] of canvases) {
          if (!state.playing) continue;
          const paused = yield* Effect.result(repository.setPlaying(canvas, false));
          if (Result.isFailure(paused)) {
            const fault = `pause at launch not saved: ${paused.failure.message}`;
            yield* Effect.sync(() =>
              console.error(`[pause] ${fault} — every canvas reads paused; writes refused`),
            );
            yield* Ref.update(memory, (current) => ({ ...current, fault }));
            return;
          }
          held.set(canvas, paused.success);
        }
        canvases = held;
      }
      yield* Ref.update(memory, (current) => ({
        ...current,
        canvases,
      }));
    });

    // Sync hot read for kernel cycle + work control dispatch. Effect.runSync
    // over a Ref read is the house-legal sync boundary (KernelService
    // .getSnapshot precedent) — never blocks, never suspends.
    const stateFor = (canvas: string): CanvasPauseState =>
      Effect.runSync(Ref.get(memory)).canvases.get(canvas) ?? PAUSED_CANVAS;

    // SQLite-first: one typed domain mutation commits before memory changes,
    // so a failed write changes nothing anywhere.
    const persist = (
      canvas: string,
      write: Effect.Effect<CanvasPauseState, unknown>,
    ): Effect.Effect<void, PauseStateError> =>
      persistLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(memory);
          if (current.fault !== undefined) {
            return yield* new PauseStateError({ message: current.fault });
          }
          const next = yield* write.pipe(
            Effect.mapError(
              (error) =>
                new PauseStateError({
                  message:
                    `pause not saved (${
                      error instanceof Error ? error.message : String(error)
                    }) — nothing changed`,
                }),
            ),
          );
          yield* Ref.update(memory, (state) => ({
            ...state,
            canvases: new Map(state.canvases).set(canvas, next),
          }));
          const notify = yield* Ref.get(listeners);
          yield* Effect.sync(() => {
            const previous = current.canvases.get(canvas) ?? PAUSED_CANVAS;
            for (const listener of notify) listener(canvas, previous, next);
          });
        }),
      );

    const setPlaying = (canvas: string, playing: boolean) =>
      persist(canvas, repository.setPlaying(canvas, playing));

    const setScopePaused = (canvas: string, scope: PauseScope, paused: boolean) =>
      scope.kind === "canvas"
        ? setPlaying(canvas, !paused)
        : persist(
            canvas,
            repository.setMemberPaused(canvas, scope, paused),
          );

    return {
      start,
      stateFor,
      setPlaying,
      setScopePaused,
      subscribe: (listener) => {
        Effect.runSync(Ref.update(listeners, (set) => new Set(set).add(listener)));
        return () => {
          Effect.runSync(
            Ref.update(listeners, (set) => {
              const next = new Set(set);
              next.delete(listener);
              return next;
            }),
          );
        };
      },
    };
  }),
);

/** Restores recorded play state: headless Remote stations and suites. */
export const PausePlaneLive = makePausePlaneLive({ resumePlayAtLaunch: true });

/** Command Center: every launch comes back paused until the operator plays. */
export const PausePlaneLaunchPausedLive = makePausePlaneLive({ resumePlayAtLaunch: false });
