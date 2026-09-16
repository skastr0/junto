import { Context, Effect, Fiber, Scope } from "effect";

export type ScopedPromiseRunner = <A, E>(
  effect: Effect.Effect<A, E>,
  options?: { readonly signal?: AbortSignal },
) => Promise<A>;

// Bridges Promise-oriented product APIs into an Effect-owned scope. Closing
// the owning layer interrupts every in-flight operation before disposal ends.
export const makeScopedPromiseRunner = (
  services: Context.Context<never>,
  owner: Scope.Scope,
): ScopedPromiseRunner =>
  (effect, options) =>
    Effect.runPromiseWith(services)(
      Effect.forkIn(effect, owner).pipe(Effect.flatMap(Fiber.join)),
      options,
    );
