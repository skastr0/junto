/**
 * The processes main starts, as one Effect scope (#576). Quit closes this
 * scope, and the scope decides the order: the core layer depends on the
 * terminals layer, so Scope's reverse-order finalizers signal the core, let it
 * finish its own drain and exit, and only then signal the terminal process its
 * seats run on. A step added later cannot get the order wrong, because there is
 * no ordered list to add it to.
 *
 * A child that is not acquired here does not exist: main starts both of them
 * through this layer and nowhere else.
 */
import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
  startTerminalProcessForCore,
  type TerminalProcessForCore,
  type TerminalsDidNotStop,
} from "../terminal-process/host";
import type { CoreProcessForMain } from "./main-boot";
import type { CoreDidNotStop } from "./host";

export class TerminalsChild extends Context.Service<TerminalsChild, TerminalProcessForCore>()(
  "@junto/TerminalsChild",
) {}

export class CoreChild extends Context.Service<CoreChild, CoreProcessForMain>()("@junto/CoreChild") {}

export type ChildDidNotStop = CoreDidNotStop | TerminalsDidNotStop;

/**
 * What the finalizers reported when the scope closed, in the order they ran. A
 * quit reads these and names them; Scope treats a failed finalizer as a whole
 * and carries on, so without a receipt a hung child would leave quietly.
 */
const failures: ChildDidNotStop[] = [];

export const takeChildStopFailures = (): ReadonlyArray<ChildDidNotStop> =>
  failures.splice(0, failures.length);

const remember = (failure: ChildDidNotStop): Effect.Effect<void> =>
  Effect.sync(() => {
    failures.push(failure);
  });

/** A release runs the child's stop and keeps a failure for the quit to name. */
const releaseChild = (stop: () => Effect.Effect<void, ChildDidNotStop>): Effect.Effect<void> =>
  Effect.suspend(stop).pipe(Effect.catch(remember));

/** One terminal process, forked when the core needs its first port. */
const TerminalsChildLive = Layer.effect(
  TerminalsChild,
  Effect.acquireRelease(
    Effect.sync(() => startTerminalProcessForCore()),
    (terminals) => releaseChild(terminals.stop),
  ),
);

export type Children = {
  readonly core: CoreProcessForMain;
  readonly terminals: TerminalProcessForCore;
  /** Close the scope: the core drains and leaves first, the terminals last. */
  readonly close: () => Promise<void>;
};

/**
 * Acquire main's children in one scope. `acquireCore` receives the terminal
 * process because the core is handed a port to it, which is also why the core
 * depends on it: the dependency is the order.
 *
 * Main's entry runs no effect of its own (index.ts is a thin shell over
 * `core.call`), so this module is the host edge that opens and closes the
 * scope: host process lifecycle, and nothing else, runs here.
 */
export const openChildren = (
  acquireCore: (terminals: TerminalProcessForCore) => CoreProcessForMain,
): Effect.Effect<Children> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const layer = Layer.effect(
      CoreChild,
      Effect.acquireRelease(
        Effect.map(TerminalsChild, acquireCore),
        (core) => releaseChild(core.stop),
      ),
    ).pipe(Layer.provideMerge(TerminalsChildLive));
    const context = yield* Layer.buildWithScope(layer, scope);
    return {
      core: Context.get(context, CoreChild),
      terminals: Context.get(context, TerminalsChild),
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  });

/** The same, for a caller that holds no runtime: main's boot. */
export const startChildren = (
  acquireCore: (terminals: TerminalProcessForCore) => CoreProcessForMain,
): Promise<Children> => Effect.runPromise(openChildren(acquireCore));
