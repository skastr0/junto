import * as Command from "@effect/platform/Command";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ProcessSpawner, ProcessSpawnerLive } from "../src/main/vellum/ssh/process-spawner";

const SpawnerLive = ProcessSpawnerLive;

describe("ProcessSpawnerLive", () => {
  it("runs through the sealed detached process-group spawner", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* (yield* ProcessSpawner).start(
            Command.make("/usr/bin/printf", "effect-process-ok"),
          );
          const completed = yield* Effect.all(
            {
              input: Stream.run(Stream.empty, process.stdin),
              stdout: Stream.runCollect(process.stdout),
              stderr: Stream.runDrain(process.stderr),
              code: process.exitCode,
            },
            { concurrency: "unbounded" },
          );
          return {
            code: completed.code,
            stdout: Buffer.concat(
              [...completed.stdout].map((chunk) => Buffer.from(chunk)),
            ).toString("utf8"),
          };
        }),
      ).pipe(Effect.provide(SpawnerLive)),
    );

    expect(result).toEqual({ code: 0, stdout: "effect-process-ok" });
  });

  it("explicitly rejects command pipelines", async () => {
    const left = Command.make("/usr/bin/printf", "x");
    const pipeline = Command.pipeTo(left, Command.make("/bin/cat"));
    const result = await Effect.runPromise(Effect.gen(function* () {
      return yield* Effect.scoped((yield* ProcessSpawner).start(pipeline));
    }).pipe(Effect.provide(SpawnerLive), Effect.either));
    expect(result._tag).toBe("Left");
  });

  it("handles async missing-executable errors without a rejection or shutdown grace", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const startedAt = Date.now();
    try {
      const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const child = yield* (yield* ProcessSpawner).start(Command.make("/definitely/not/a-vellum-command"));
        yield* Effect.sleep(30);
        return yield* Effect.either(child.exitCode);
      })).pipe(Effect.provide(SpawnerLive)));
      expect(result._tag).toBe("Left");
      expect(Date.now() - startedAt).toBeLessThan(500);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("immediately closes a missing executable scope without a signal grace", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const startedAt = Date.now();
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const child = yield* (yield* ProcessSpawner).start(Command.make("/definitely/not-a-vellum-command-immediate"));
        // Deliberately no sleep or exitCode await: this is the finalizer race.
        yield* child.isRunning;
      })).pipe(Effect.provide(SpawnerLive)));
      expect(Date.now() - startedAt).toBeLessThan(500);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("terminates a responsive owned process without waiting through the grace period", async () => {
    const startedAt = Date.now();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* ProcessSpawner).start(Command.make("/bin/cat"));
          yield* Effect.sleep(20);
        }),
      ).pipe(Effect.provide(SpawnerLive)),
    );

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("escalates from SIGTERM to SIGKILL after a bounded grace period", async () => {
    const startedAt = Date.now();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* (yield* ProcessSpawner).start(
            Command.make(
              "/bin/sh",
              "-c",
              "trap '' TERM; printf ready; while :; do sleep 1; done",
            ),
          );
          yield* Stream.runHead(child.stdout);
        }),
      ).pipe(Effect.provide(SpawnerLive)),
    );
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(4_500);
  });
});
