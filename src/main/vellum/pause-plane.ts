import { Context, Effect, Either, Layer, Ref, Schema } from "effect";
import { StoreService } from "../services/store";
import { PAUSED_CANVAS, type CanvasPauseState, type PauseScope } from "@shared/pause";

// Factory pause plane — the safety switch that decides whether the factory
// may act at all. App-state, never the document (same doctrine as region
// arming, canvas.ts:193): definitions travel with the file; the switch that
// spends real actions exists only in the running app, flipped by a human.
//
// LAW (enforced here and in @shared/pause): a canvas with no recorded play
// decision is PAUSED. The factory is born paused; the first play is an
// explicit operator confirmation (everPlayed is the latch the UI reads).
//
// Fail closed, fail loud: an unreadable store leaves every canvas paused
// and refuses writes so the corrupt file is never clobbered.

const PAUSE_STORE_KEY = "factory.pause";

type StoredRecord = {
  readonly playing?: boolean;
  readonly everPlayed?: boolean;
  readonly nodes?: ReadonlyArray<string>;
  readonly regions?: ReadonlyArray<string>;
};
type StoredMap = Record<string, StoredRecord>;

/** A pause write that could not land: store fault at hydration or on persist. */
export class PauseStoreError extends Schema.TaggedError<PauseStoreError>()(
  "PauseStoreError",
  { message: Schema.String },
) {}

export class PausePlane extends Context.Tag("vellum/PausePlane")<
  PausePlane,
  {
    /** Hydrate from store. Idempotent. */
    readonly start: Effect.Effect<void>;
    /** Sync hot read — unknown canvas is the born-paused default. */
    readonly stateFor: (canvas: string) => CanvasPauseState;
    /** Canvas play/pause. Playing stamps everPlayed. Store-first. */
    readonly setPlaying: (
      canvas: string,
      playing: boolean,
    ) => Effect.Effect<void, PauseStoreError>;
    /** Node/region pause. Canvas scope routes to setPlaying(!paused). */
    readonly setScopePaused: (
      canvas: string,
      scope: PauseScope,
      paused: boolean,
    ) => Effect.Effect<void, PauseStoreError>;
    readonly subscribe: (listener: (canvas: string) => void) => () => void;
  }
>() {}

const decode = (record: StoredRecord | undefined): CanvasPauseState => ({
  playing: record?.playing === true,
  everPlayed: record?.everPlayed === true,
  pausedNodes: [...(record?.nodes ?? [])],
  pausedRegions: [...(record?.regions ?? [])],
});

const encode = (state: CanvasPauseState): StoredRecord => ({
  ...(state.playing ? { playing: true } : {}),
  ...(state.everPlayed ? { everPlayed: true } : {}),
  ...(state.pausedNodes.length > 0 ? { nodes: [...state.pausedNodes] } : {}),
  ...(state.pausedRegions.length > 0 ? { regions: [...state.pausedRegions] } : {}),
});

const withMember = (
  list: ReadonlyArray<string>,
  id: string,
  present: boolean,
): ReadonlyArray<string> => {
  const rest = list.filter((entry) => entry !== id);
  return present ? [...rest, id] : rest;
};

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
  /** Set when the store could not be read at hydration — every write refuses. */
  readonly fault: string | undefined;
};

export const PausePlaneLive = Layer.effect(
  PausePlane,
  Effect.gen(function* () {
    const store = yield* StoreService;
    const memory = yield* Ref.make<PlaneMemory>({
      hydrated: false,
      canvases: new Map(),
      fault: undefined,
    });
    const listeners = yield* Ref.make<ReadonlySet<(canvas: string) => void>>(new Set());
    // Persist is a read-compose-write-update transaction over the whole map;
    // one permit keeps concurrent writes from composing against a stale read.
    const persistLock = yield* Effect.makeSemaphore(1);

    const start = Effect.gen(function* () {
      const alreadyHydrated = yield* Ref.modify(
        memory,
        (current) => [current.hydrated, { ...current, hydrated: true }] as const,
      );
      if (alreadyHydrated) return;
      const read = yield* Effect.either(store.get<StoredMap>(PAUSE_STORE_KEY));
      if (Either.isLeft(read)) {
        const fault = `pause store unreadable: ${read.left.message}`;
        yield* Effect.sync(() =>
          console.error(`[pause] ${fault} — every canvas reads paused; writes refused`),
        );
        yield* Ref.update(memory, (current) => ({ ...current, fault }));
        return;
      }
      const canvases = new Map<string, CanvasPauseState>();
      for (const [canvas, record] of Object.entries(read.right ?? {})) {
        canvases.set(canvas, decode(record));
      }
      yield* Ref.update(memory, (current) => ({ ...current, canvases }));
    });

    // Sync hot read for kernel cycle + work control dispatch. Effect.runSync
    // over a Ref read is the house-legal sync boundary (KernelService
    // .getSnapshot precedent) — never blocks, never suspends.
    const stateFor = (canvas: string): CanvasPauseState =>
      Effect.runSync(Ref.get(memory)).canvases.get(canvas) ?? PAUSED_CANVAS;

    // Store-first: the whole map (with `next` swapped in) lands on disk before
    // memory mutates, so a failed write changes nothing anywhere.
    const persist = (
      canvas: string,
      compute: (current: CanvasPauseState) => CanvasPauseState,
    ): Effect.Effect<void, PauseStoreError> =>
      persistLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(memory);
          if (current.fault !== undefined) {
            return yield* new PauseStoreError({ message: current.fault });
          }
          const next = compute(current.canvases.get(canvas) ?? PAUSED_CANVAS);
          const whole: StoredMap = {};
          for (const [name, state] of current.canvases) whole[name] = encode(state);
          whole[canvas] = encode(next);
          yield* store.set(PAUSE_STORE_KEY, whole).pipe(
            Effect.mapError(
              (error) =>
                new PauseStoreError({
                  message: `pause not saved (${error.message}) — nothing changed`,
                }),
            ),
          );
          yield* Ref.update(memory, (state) => ({
            ...state,
            canvases: new Map(state.canvases).set(canvas, next),
          }));
          const notify = yield* Ref.get(listeners);
          yield* Effect.sync(() => {
            for (const listener of notify) listener(canvas);
          });
        }),
      );

    const setPlaying = (canvas: string, playing: boolean) =>
      persist(canvas, (current) => ({
        ...current,
        playing,
        everPlayed: current.everPlayed || playing,
      }));

    const setScopePaused = (canvas: string, scope: PauseScope, paused: boolean) =>
      scope.kind === "canvas"
        ? setPlaying(canvas, !paused)
        : persist(canvas, (current) =>
            scope.kind === "node"
              ? { ...current, pausedNodes: withMember(current.pausedNodes, scope.id, paused) }
              : {
                  ...current,
                  pausedRegions: withMember(current.pausedRegions, scope.id, paused),
                },
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
