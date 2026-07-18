import { Effect, Fiber, Runtime, Scope } from "effect";

export type ScopedPromiseRunner = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

// Bridges Promise-oriented product APIs into an Effect-owned scope. Closing
// the owning layer interrupts every in-flight operation before disposal ends.
export const makeScopedPromiseRunner = (
  runtime: Runtime.Runtime<never>,
  owner: Scope.Scope,
): ScopedPromiseRunner =>
  (effect) =>
    Runtime.runPromise(runtime)(
      Effect.forkIn(effect, owner).pipe(Effect.flatMap(Fiber.join)),
    );
