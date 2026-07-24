import { Context, Effect, Either, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import { StoreError, StoreService } from "../src/main/services/store";
import { PausePlane, PausePlaneLive } from "../src/main/vellum/pause-plane";
import { PAUSED_CANVAS } from "../src/shared/pause";

// Focused suite for the pause plane itself (fake StoreService): born-paused
// default, everPlayed latch, corrupt-store fail-closed refusing writes, and
// the node/region scope round-trip. The pure law lives in tests/pause.test.ts.

const PAUSE_STORE_KEY = "factory.pause";

const check = (id: string) => ({ id, label: id, status: "ok" as const, detail: "" });

type SetRecord = { readonly key: string; readonly value: unknown };

type StoreBehavior = {
  readonly initial?: Record<string, unknown>;
  readonly getFails?: boolean;
  readonly setFails?: boolean;
};

const makeStore = (behavior: StoreBehavior, sets: SetRecord[]) =>
  Layer.succeed(
    StoreService,
    StoreService.of({
      doctor: Effect.succeed(check("store")),
      get: <T>(key: string) =>
        behavior.getFails
          ? Effect.fail(new StoreError({ message: "corrupt json" }))
          : Effect.succeed(behavior.initial?.[key] as T | undefined),
      set: <T>(key: string, value: T) =>
        behavior.setFails
          ? Effect.fail(new StoreError({ message: "disk full" }))
          : Effect.sync(() => void sets.push({ key, value })),
    }),
  );

type Plane = Context.Tag.Service<typeof PausePlane>;

const withPlane = async <A>(
  behavior: StoreBehavior,
  sets: SetRecord[],
  use: (plane: Plane) => Promise<A>,
): Promise<A> => {
  const runtime = ManagedRuntime.make(Layer.provide(PausePlaneLive, makeStore(behavior, sets)));
  try {
    const plane = await runtime.runPromise(PausePlane);
    await runtime.runPromise(plane.start);
    return await use(plane);
  } finally {
    await runtime.dispose();
  }
};

describe("PausePlane — born paused", () => {
  it("an unknown canvas reads the born-paused default", async () => {
    await withPlane({}, [], async (plane) => {
      expect(plane.stateFor("never-seen")).toEqual(PAUSED_CANVAS);
    });
  });

  it("hydrates persisted records; start is idempotent", async () => {
    await withPlane(
      { initial: { [PAUSE_STORE_KEY]: { ether: { playing: true, everPlayed: true } } } },
      [],
      async (plane) => {
        expect(plane.stateFor("ether").playing).toBe(true);
        expect(plane.stateFor("ether").everPlayed).toBe(true);
        // Second start must not re-read or reset anything.
        await Effect.runPromise(plane.start);
        expect(plane.stateFor("ether").playing).toBe(true);
      },
    );
  });
});

describe("PausePlane — setPlaying", () => {
  it("playing stamps everPlayed, and the latch survives pausing again", async () => {
    const sets: SetRecord[] = [];
    await withPlane({}, sets, async (plane) => {
      const seen: string[] = [];
      const unsubscribe = plane.subscribe((canvas) => seen.push(canvas));

      await Effect.runPromise(plane.setPlaying("ether", true));
      expect(plane.stateFor("ether")).toMatchObject({ playing: true, everPlayed: true });

      await Effect.runPromise(plane.setPlaying("ether", false));
      expect(plane.stateFor("ether")).toMatchObject({ playing: false, everPlayed: true });

      expect(seen).toEqual(["ether", "ether"]);
      unsubscribe();

      // Store-first persistence: the paused-but-everPlayed record reached disk.
      const last = sets.at(-1);
      expect(last?.key).toBe(PAUSE_STORE_KEY);
      expect(last?.value).toEqual({ ether: { everPlayed: true } });
    });
  });

  it("a FAILED store write is a typed error and leaves memory untouched", async () => {
    await withPlane({ setFails: true }, [], async (plane) => {
      const result = await Effect.runPromise(Effect.either(plane.setPlaying("ether", true)));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("PauseStoreError");
        expect(result.left.message).toMatch(/not saved/i);
      }
      expect(plane.stateFor("ether")).toEqual(PAUSED_CANVAS);
    });
  });
});

describe("PausePlane — corrupt store fails closed", () => {
  it("every canvas reads paused and writes refuse — the file is never clobbered", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sets: SetRecord[] = [];
      await withPlane({ getFails: true }, sets, async (plane) => {
        expect(plane.stateFor("ether")).toEqual(PAUSED_CANVAS);

        const result = await Effect.runPromise(Effect.either(plane.setPlaying("ether", true)));
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left._tag).toBe("PauseStoreError");
          expect(result.left.message).toMatch(/unreadable/i);
        }
        // Refused before the store was touched — never clobbered.
        expect(sets).toEqual([]);
        expect(plane.stateFor("ether")).toEqual(PAUSED_CANVAS);
      });
    } finally {
      error.mockRestore();
    }
  });
});

describe("PausePlane — scope pause round-trip", () => {
  it("node and region pauses set and clear; canvas scope routes to setPlaying", async () => {
    await withPlane({}, [], async (plane) => {
      await Effect.runPromise(plane.setPlaying("ether", true));

      await Effect.runPromise(plane.setScopePaused("ether", { kind: "node", id: "n1" }, true));
      await Effect.runPromise(plane.setScopePaused("ether", { kind: "region", id: "r1" }, true));
      expect(plane.stateFor("ether").pausedNodes).toEqual(["n1"]);
      expect(plane.stateFor("ether").pausedRegions).toEqual(["r1"]);

      await Effect.runPromise(plane.setScopePaused("ether", { kind: "node", id: "n1" }, false));
      await Effect.runPromise(plane.setScopePaused("ether", { kind: "region", id: "r1" }, false));
      expect(plane.stateFor("ether").pausedNodes).toEqual([]);
      expect(plane.stateFor("ether").pausedRegions).toEqual([]);

      await Effect.runPromise(plane.setScopePaused("ether", { kind: "canvas" }, true));
      expect(plane.stateFor("ether")).toMatchObject({ playing: false, everPlayed: true });
      await Effect.runPromise(plane.setScopePaused("ether", { kind: "canvas" }, false));
      expect(plane.stateFor("ether").playing).toBe(true);
    });
  });
});
