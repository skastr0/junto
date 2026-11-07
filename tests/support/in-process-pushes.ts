/**
 * What the core pushes reaches main's subscribers in the same process, as the
 * port relay does in the app (`main-side/window-pushes.ts`): the form a test
 * provides when it listens for a push.
 */
import { Effect, Exit, Scope } from "effect";
import { deliverPush, makeCorePushesMain } from "../../src/app/core-process/main-side/core-pushes";
import { CorePushes } from "../../src/core/push";

/**
 * Main's push bus for one test, as main-boot builds it, and the core's pushes
 * over its feed: give `layer` or `shape` to the core under test and
 * `pushes` (CorePushesMain) to main's registrar. `close` ends the bus.
 */
export const inProcessBus = () => {
  const scope = Scope.makeUnsafe();
  const { pushes, deliver } = Effect.runSync(Scope.provide(makeCorePushesMain, scope));
  return {
    pushes,
    layer: CorePushes.toPort(deliver),
    shape: CorePushes.over(deliver),
    close: (): void => Effect.runSync(Scope.close(scope, Exit.void)),
  };
};

export const inProcessPushes = CorePushes.toPort(deliverPush);

/** The same pushes as a value, for code that takes them as an argument. */
export const inProcessPushesShape = CorePushes.over(deliverPush);
