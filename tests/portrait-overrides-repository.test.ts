import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import {
  PortraitOverrideRepository,
  PortraitOverrideRepositoryLive,
} from "../src/main/junto/portraits/repository";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<PortraitOverrideRepository, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-portraits-"));
  runtime = ManagedRuntime.make(
    PortraitOverrideRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, PortraitOverrideRepository>) => runtime.runPromise(effect);

describe("PortraitOverrideRepository", () => {
  it("stores one row per seat, replaces it, and resets it", async () => {
    const listed = await run(
      Effect.gen(function* () {
        const r = yield* PortraitOverrideRepository;
        yield* r.set("seat-a", { shape: "toast", temperament: 0.5 });
        yield* r.set("seat-b", { eyes: "dot" });
        yield* r.set("seat-a", { topper: "cat" });
        return yield* r.list();
      }),
    );
    expect(listed).toEqual({ "seat-a": { topper: "cat" }, "seat-b": { eyes: "dot" } });

    const afterReset = await run(
      Effect.gen(function* () {
        const r = yield* PortraitOverrideRepository;
        expect(yield* r.set("seat-b", null)).toBeNull();
        // An override with nothing usable left is a reset too.
        expect(yield* r.set("seat-a", { hat: "top" } as never)).toBeNull();
        return yield* r.list();
      }),
    );
    expect(afterReset).toEqual({});
  });

  it("holds hundreds of seats with no shared size ceiling", async () => {
    const count = await run(
      Effect.gen(function* () {
        const r = yield* PortraitOverrideRepository;
        for (let index = 0; index < 600; index += 1) {
          yield* r.set(`seat-${index}`, { shape: "toast", eyes: "sparkle", temperament: 0.25 });
        }
        return Object.keys(yield* r.list()).length;
      }),
    );
    expect(count).toBe(600);
  });
});
