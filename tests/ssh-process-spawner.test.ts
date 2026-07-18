import * as Command from "@effect/platform/Command";
import * as NodeCommandExecutor from "@effect/platform-node/NodeCommandExecutor";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { ProcessSpawner, ProcessSpawnerLive } from "../src/main/vellum/ssh/process-spawner";

const NodeExecutorLive = NodeCommandExecutor.layer.pipe(
  Layer.provide(NodeFileSystem.layer),
);

const SpawnerLive = ProcessSpawnerLive.pipe(
  Layer.provide(NodeExecutorLive),
);

describe("ProcessSpawnerLive", () => {
  it("runs through the official scoped Node command executor", async () => {
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
