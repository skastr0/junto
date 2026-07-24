import { Context, Effect, Layer } from "effect";
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

export type PauseWriteResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export class PausePlane extends Context.Tag("vellum/PausePlane")<
  PausePlane,
  {
    /** Hydrate from store. Idempotent. */
    readonly start: () => Promise<void>;
    /** Sync hot read — unknown canvas is the born-paused default. */
    readonly stateFor: (canvas: string) => CanvasPauseState;
    /** Canvas play/pause. Playing stamps everPlayed. Store-first. */
    readonly setPlaying: (canvas: string, playing: boolean) => Promise<PauseWriteResult>;
    /** Node/region pause. Canvas scope routes to setPlaying(!paused). */
    readonly setScopePaused: (
      canvas: string,
      scope: PauseScope,
      paused: boolean,
    ) => Promise<PauseWriteResult>;
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
  start: async () => {},
  stateFor: () => ({ playing: true, everPlayed: true, pausedNodes: [], pausedRegions: [] }),
  setPlaying: async () => ({ ok: true }),
  setScopePaused: async () => ({ ok: true }),
  subscribe: () => () => {},
});

export const PausePlaneLive = Layer.effect(
  PausePlane,
  Effect.gen(function* () {
    const store = yield* StoreService;
    const memory = new Map<string, CanvasPauseState>();
    const listeners = new Set<(canvas: string) => void>();
    let fault: string | undefined;
    let hydrated = false;

    const start = async (): Promise<void> => {
      if (hydrated) return;
      hydrated = true;
      const read = await Effect.runPromise(
        Effect.either(store.get<StoredMap>(PAUSE_STORE_KEY)),
      );
      if (read._tag === "Left") {
        fault = `pause store unreadable: ${read.left.message}`;
        console.error(`[pause] ${fault} — every canvas reads paused; writes refused`);
        return;
      }
      for (const [canvas, record] of Object.entries(read.right ?? {})) {
        memory.set(canvas, decode(record));
      }
    };

    const stateFor = (canvas: string): CanvasPauseState =>
      memory.get(canvas) ?? PAUSED_CANVAS;

    const persist = async (
      canvas: string,
      next: CanvasPauseState,
    ): Promise<PauseWriteResult> => {
      if (fault !== undefined) return { ok: false, error: fault };
      const whole: StoredMap = {};
      for (const [name, state] of memory) whole[name] = encode(state);
      whole[canvas] = encode(next);
      const wrote = await Effect.runPromise(
        Effect.either(store.set(PAUSE_STORE_KEY, whole)),
      );
      if (wrote._tag === "Left") {
        return {
          ok: false,
          error: `pause not saved (${wrote.left.message}) — nothing changed`,
        };
      }
      memory.set(canvas, next);
      for (const listener of listeners) listener(canvas);
      return { ok: true };
    };

    const setPlaying = (canvas: string, playing: boolean): Promise<PauseWriteResult> => {
      const current = stateFor(canvas);
      return persist(canvas, {
        ...current,
        playing,
        everPlayed: current.everPlayed || playing,
      });
    };

    const setScopePaused = (
      canvas: string,
      scope: PauseScope,
      paused: boolean,
    ): Promise<PauseWriteResult> => {
      if (scope.kind === "canvas") return setPlaying(canvas, !paused);
      const current = stateFor(canvas);
      const next: CanvasPauseState =
        scope.kind === "node"
          ? { ...current, pausedNodes: withMember(current.pausedNodes, scope.id, paused) }
          : { ...current, pausedRegions: withMember(current.pausedRegions, scope.id, paused) };
      return persist(canvas, next);
    };

    return {
      start,
      stateFor,
      setPlaying,
      setScopePaused,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  }),
);
