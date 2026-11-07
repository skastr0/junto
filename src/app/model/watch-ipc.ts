/**
 * The model watches, asked of every core (src/contract/core/watch.ts): each
 * core starts its watches when asked and publishes on their channels, which
 * junto/ipc.ts forwards to the window. A core that starts again has none
 * until it is asked, so each ask runs again on every core that says ready
 * (core-process/every-core.ts); asking twice starts nothing new.
 */
import { Context } from "effect";
import { WatchCore } from "../../contract/core/watch";
import { askOnEveryCore } from "../core-process/every-core";
import { AppRuntime } from "../runtime";

export const registerModelWatches = (core: Context.Context<WatchCore>): void => {
  const watch = Context.get(core, WatchCore);
  askOnEveryCore("ipc.watch.model", () => AppRuntime.runPromise(watch.WatchModel()));
  askOnEveryCore("ipc.watch.modelCanvases", () => AppRuntime.runPromise(watch.WatchModelCanvases()));
  askOnEveryCore("ipc.watch.modelActorRefs", () => AppRuntime.runPromise(watch.WatchModelActorRefs()));
};
