import { Effect, Exit, Scope } from "effect";

/**
 * A stop as one Effect scope of finalizers, for the two places that have no
 * warm runtime to close it on.
 *
 * Main's shell builds no core runtime — index.ts starts the core process and
 * asks it by name — and the core's own stop disposes its runtime as one of its
 * steps, so neither can close this scope on a ManagedRuntime. It is created and
 * closed on the default runtime instead, after the runtime the steps belonged to
 * is gone; that is why this file sits on the runPromise allowlist as a
 * host/post-dispose edge.
 *
 * Every step is a plain host promise that carries its own failure. Steps run in
 * the order given, one that fails does not skip the rest, and the first failure
 * is what the caller reports.
 */
export const runStopSteps = async (
  steps: ReadonlyArray<() => Promise<void>>,
): Promise<void> => {
  const failures: unknown[] = [];
  const scope = Effect.runSync(Scope.make());
  for (const step of [...steps].reverse()) {
    Effect.runSync(Scope.addFinalizer(scope, Effect.promise(async () => {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    })));
  }
  await Effect.runPromise(Scope.close(scope, Exit.void));
  if (failures.length > 0) throw failures[0];
};
