import { Context, Effect, Result, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  FactoryPausePersistenceError,
  FactoryPauseRepository,
  type PauseMemberScope,
} from "../src/main/junto/pause/repository";
import {
  PausePlane,
  PausePlaneLive,
} from "../src/main/junto/pause-plane";
import {
  PAUSED_CANVAS,
  pauseWasResumed,
  type CanvasPauseState,
} from "../src/shared/pause";

type RepositoryBehavior = {
  readonly initial?: ReadonlyMap<string, CanvasPauseState>;
  readonly loadFails?: boolean;
  readonly writeFails?: boolean;
};

type Write =
  | {
      readonly kind: "canvas";
      readonly canvas: string;
      readonly playing: boolean;
    }
  | {
      readonly kind: "member";
      readonly canvas: string;
      readonly scope: PauseMemberScope;
      readonly paused: boolean;
    };

const failure = (operation: string) =>
  FactoryPausePersistenceError.make({
    operation,
    message: operation === "load" ? "database corrupt" : "disk full",
    cause: new Error(operation),
  });

const withMember = (
  values: ReadonlyArray<string>,
  id: string,
  present: boolean,
): ReadonlyArray<string> => {
  const rest = values.filter((value) => value !== id);
  return present ? [...rest, id] : rest;
};

const makeRepository = (
  behavior: RepositoryBehavior,
  writes: Write[],
): Layer.Layer<FactoryPauseRepository> => {
  const states = new Map(behavior.initial ?? []);
  return Layer.succeed(
    FactoryPauseRepository,
    FactoryPauseRepository.of({
      loadAll: behavior.loadFails
        ? Effect.fail(failure("load"))
        : Effect.succeed(new Map(states)),
      setPlaying: (canvas, playing) => {
        if (behavior.writeFails) return Effect.fail(failure("write"));
        return Effect.sync(() => {
          const current = states.get(canvas) ?? PAUSED_CANVAS;
          const next = {
            ...current,
            playing,
            everPlayed: current.everPlayed || playing,
          };
          states.set(canvas, next);
          writes.push({ kind: "canvas", canvas, playing });
          return next;
        });
      },
      setMemberPaused: (canvas, scope, paused) => {
        if (behavior.writeFails) return Effect.fail(failure("write"));
        return Effect.sync(() => {
          const current = states.get(canvas) ?? PAUSED_CANVAS;
          const next =
            scope.kind === "node"
              ? {
                  ...current,
                  pausedNodes: withMember(
                    current.pausedNodes,
                    scope.id,
                    paused,
                  ),
                }
              : {
                  ...current,
                  pausedRegions: withMember(
                    current.pausedRegions,
                    scope.id,
                    paused,
                  ),
                };
          states.set(canvas, next);
          writes.push({ kind: "member", canvas, scope, paused });
          return next;
        });
      },
    }),
  );
};

type Plane = Context.Service.Shape<typeof PausePlane>;

const withPlane = async <A>(
  behavior: RepositoryBehavior,
  writes: Write[],
  use: (plane: Plane) => Promise<A>,
): Promise<A> => {
  const runtime = ManagedRuntime.make(
    Layer.provide(PausePlaneLive, makeRepository(behavior, writes)),
  );
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

  it("hydrates normalized records; start is idempotent", async () => {
    await withPlane(
      {
        initial: new Map([
          [
            "ether",
            {
              playing: true,
              everPlayed: true,
              pausedNodes: [],
              pausedRegions: [],
            },
          ],
        ]),
      },
      [],
      async (plane) => {
        expect(plane.stateFor("ether").playing).toBe(true);
        expect(plane.stateFor("ether").everPlayed).toBe(true);
        await Effect.runPromise(plane.start);
        expect(plane.stateFor("ether").playing).toBe(true);
      },
    );
  });
});

describe("PausePlane — setPlaying", () => {
  it("emits committed before/after states so only actual resume changes re-drive mail", async () => {
    await withPlane({}, [], async (plane) => {
      const resumes: string[] = [];
      const seen: CanvasPauseState[] = [];
      const stop = plane.subscribe((canvas, previous, current) => {
        expect(plane.stateFor(canvas)).toEqual(current);
        seen.push(previous);
        if (pauseWasResumed(previous, current)) resumes.push(canvas);
      });
      await Effect.runPromise(plane.setPlaying("a", true));
      await Effect.runPromise(plane.setPlaying("a", true));
      await Effect.runPromise(plane.setScopePaused("a", { kind: "node", id: "n" }, true));
      await Effect.runPromise(plane.setScopePaused("a", { kind: "node", id: "n" }, false));
      await Effect.runPromise(plane.setScopePaused("a", { kind: "region", id: "r" }, true));
      await Effect.runPromise(plane.setScopePaused("a", { kind: "region", id: "r" }, false));
      await Effect.runPromise(plane.setPlaying("b", true));
      expect(resumes).toEqual(["a", "a", "a", "b"]);
      expect(seen[0]).toEqual(PAUSED_CANVAS);
      expect(seen[2].pausedNodes).toEqual([]);
      expect(seen[3].pausedNodes).toEqual(["n"]);
      stop();
    });
  });

  it("playing stamps everPlayed, and the latch survives pausing again", async () => {
    const writes: Write[] = [];
    await withPlane({}, writes, async (plane) => {
      const seen: string[] = [];
      const unsubscribe = plane.subscribe((canvas) => seen.push(canvas));

      await Effect.runPromise(plane.setPlaying("ether", true));
      expect(plane.stateFor("ether")).toMatchObject({
        playing: true,
        everPlayed: true,
      });

      await Effect.runPromise(plane.setPlaying("ether", false));
      expect(plane.stateFor("ether")).toMatchObject({
        playing: false,
        everPlayed: true,
      });

      expect(seen).toEqual(["ether", "ether"]);
      expect(writes).toEqual([
        { kind: "canvas", canvas: "ether", playing: true },
        { kind: "canvas", canvas: "ether", playing: false },
      ]);
      unsubscribe();
    });
  });

  it("a failed repository write is typed and leaves memory untouched", async () => {
    await withPlane({ writeFails: true }, [], async (plane) => {
      const result = await Effect.runPromise(
        Effect.result(plane.setPlaying("ether", true)),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("PauseStateError");
        expect(result.failure.message).toMatch(/not saved/i);
      }
      expect(plane.stateFor("ether")).toEqual(PAUSED_CANVAS);
    });
  });
});

describe("PausePlane — corrupt state fails closed", () => {
  it("every canvas reads paused and writes refuse without touching the repository", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const writes: Write[] = [];
      await withPlane({ loadFails: true }, writes, async (plane) => {
        expect(plane.stateFor("ether")).toEqual(PAUSED_CANVAS);

        const result = await Effect.runPromise(
          Effect.result(plane.setPlaying("ether", true)),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("PauseStateError");
          expect(result.failure.message).toMatch(/unreadable/i);
        }
        expect(writes).toEqual([]);
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

      await Effect.runPromise(
        plane.setScopePaused("ether", { kind: "node", id: "n1" }, true),
      );
      await Effect.runPromise(
        plane.setScopePaused("ether", { kind: "region", id: "r1" }, true),
      );
      expect(plane.stateFor("ether").pausedNodes).toEqual(["n1"]);
      expect(plane.stateFor("ether").pausedRegions).toEqual(["r1"]);

      await Effect.runPromise(
        plane.setScopePaused("ether", { kind: "node", id: "n1" }, false),
      );
      await Effect.runPromise(
        plane.setScopePaused("ether", { kind: "region", id: "r1" }, false),
      );
      expect(plane.stateFor("ether").pausedNodes).toEqual([]);
      expect(plane.stateFor("ether").pausedRegions).toEqual([]);

      await Effect.runPromise(
        plane.setScopePaused("ether", { kind: "canvas" }, true),
      );
      expect(plane.stateFor("ether")).toMatchObject({
        playing: false,
        everPlayed: true,
      });
      await Effect.runPromise(
        plane.setScopePaused("ether", { kind: "canvas" }, false),
      );
      expect(plane.stateFor("ether").playing).toBe(true);
    });
  });
});
