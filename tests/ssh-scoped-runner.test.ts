import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { makeScopedPromiseRunner } from "../src/main/vellum/ssh";

describe("makeScopedPromiseRunner", () => {
  it("interrupts and finalizes in-flight Promise bridges when the owner closes", async () => {
    const runtime = await Effect.runPromise(Effect.runtime<never>());
    const owner = await Effect.runPromise(Scope.make());
    const runOwned = makeScopedPromiseRunner(runtime, owner);
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    let finalized = false;

    const running = runOwned(Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(releaseStarted),
        () => Effect.sync(() => { finalized = true; }),
      ).pipe(Effect.zipRight(Effect.never)),
    ));
    await started;
    await Effect.runPromise(Scope.close(owner, Exit.void));

    await expect(running).rejects.toBeDefined();
    expect(finalized).toBe(true);
  });
});
