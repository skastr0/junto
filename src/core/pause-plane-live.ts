/**
 * The pause plane's live layers, on the factory pause rows. They belong to the
 * core that holds the store; a module that only names `PausePlane` (the tag in
 * pause-plane.ts) links no pause repository.
 */
import { Context, Effect, Layer, Ref, Result, Semaphore } from "effect";
import { PAUSED_CANVAS, type CanvasPauseState, type PauseChangeListener } from "@shared/pause";
import { FactoryPauseRepository } from "./pause/repository";
import { PausePlane, PauseStateError } from "./pause-plane";

type PlaneMemory = {
  readonly hydrated: boolean;
  readonly canvases: ReadonlyMap<string, CanvasPauseState>;
  /** Set when SQLite could not be read at hydration — every write refuses. */
  readonly fault: string | undefined;
};

export interface PausePlaneOptions {
  /**
   * Play state at start. "play" plays every canvas this machine edits that
   * has ever played, durably, before any reader sees it (the Command Center
   * launch law); a canvas held as a copy keeps what its last copy said;
   * "keep" restores the record (headless Remote stations, suites).
   */
  readonly launch: "keep" | "play";
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
      if (options.launch === "play") {
        const copies = yield* Effect.result(repository.copies);
        if (Result.isFailure(copies)) {
          // Fail closed: which canvases are copies is unknown, so none is played.
          const fault = `copies unreadable at launch: ${copies.failure.message}`;
          yield* Effect.sync(() =>
            console.error(`[pause] ${fault} — every canvas reads paused; writes refused`),
          );
          yield* Ref.update(memory, (current) => ({ ...current, fault }));
          return;
        }
        const resumed = new Map(canvases);
        for (const [canvas, state] of canvases) {
          if (state.playing || !state.everPlayed || copies.success.has(canvas)) continue;
          const playing = yield* Effect.result(repository.setPlaying(canvas, true));
          if (Result.isFailure(playing)) {
            // Fail closed: nothing loads, so every canvas reads paused.
            const fault = `play at launch not saved: ${playing.failure.message}`;
            yield* Effect.sync(() =>
              console.error(`[pause] ${fault} — every canvas reads paused; writes refused`),
            );
            yield* Ref.update(memory, (current) => ({ ...current, fault }));
            return;
          }
          resumed.set(canvas, playing.success);
        }
        canvases = resumed;
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

    return {
      start,
      stateFor,
      setPlaying,
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
export const PausePlaneLive = makePausePlaneLive({ launch: "keep" });

/** Command Center: every canvas played before comes back playing. */
export const PausePlaneLaunchPlayingLive = makePausePlaneLive({ launch: "play" });
