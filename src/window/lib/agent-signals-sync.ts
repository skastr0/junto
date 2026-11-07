/**
 * The open canvas's agent signals, kept in the window's store
 * (agent-signals-state.ts): a service of the window's runtime
 * (src/window/rpc/runtime.ts), built once at boot. It follows the core's
 * changes on `SignalsChanged` for as long as the runtime lives, and lists
 * the canvas again each time the operator opens another one. Never writes
 * the canvas. It imports no runtime module: the runtime builds it.
 */
import { Context, Effect, FiberSet, Layer, Stream } from "effect";
import { SignalsWindow } from "../../contract/window/signals";
import { agentSignals$, replaceAgentSignals, upsertAgentSignal } from "./agent-signals-state";
import { state$ } from "./state";

export class AgentSignalsSync extends Context.Service<AgentSignalsSync, {}>()("@junto/window/AgentSignalsSync") {
  static readonly layer = Layer.effect(
    AgentSignalsSync,
    Effect.gen(function* () {
      const signals = yield* SignalsWindow;
      // Each canvas change lists in a fiber the runtime ends with it.
      const run = yield* FiberSet.makeRuntime<never, void, never>();

      // The stream opens before the first list, so no change is lost between them.
      yield* signals.SignalsChanged().pipe(
        Stream.runForEach((signal) => Effect.sync(() => upsertAgentSignal(signal))),
        Effect.ignore,
        Effect.forkScoped,
      );

      const hydrate = (canvasName: string): Effect.Effect<void> => {
        if (canvasName === "") return Effect.sync(() => replaceAgentSignals("", []));
        return signals.SignalsList({ canvasName }).pipe(
          Effect.flatMap((listed) =>
            Effect.sync(() => {
              if (state$.canvasName.peek() !== canvasName) return;
              // Changes that raced the listing are newer than it; keep them over the list.
              const live = Object.values(agentSignals$.peek()).filter((signal) => signal.canvasName === canvasName);
              replaceAgentSignals(canvasName, [...listed, ...live]);
            }),
          ),
          Effect.ignore,
        );
      };

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          state$.canvasName.onChange(({ value }) => {
            replaceAgentSignals(value, []);
            run(hydrate(value));
          }),
        ),
        (off) => Effect.sync(off),
      );
      yield* hydrate(state$.canvasName.peek()).pipe(Effect.forkScoped);
      return {};
    }),
  );
}
