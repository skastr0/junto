/**
 * Every window group's handlers, as main's boot hands them to the window link
 * (src/app/window/ipc.ts): main's own groups, and the core groups it forwards
 * through its clients of the core. A group in `WindowRpcs` without its
 * handlers here fails this file's compile.
 */
import { type Context, Effect, Layer } from "effect";
import type { CoreClients } from "../core-process/clients";
import { ReferencesWindowHandlers } from "../references/ipc";
import { ShellEnvironmentWindowHandlers } from "../shell-environment/ipc";
import { AppRuntime } from "../runtime";
import { updateWindowHandlers } from "../update/ipc";
import type { UpdateInstall } from "../update/provider";
import { UpdateService } from "../update/service";
import type { WindowHandlers } from "./ipc";

/**
 * The update service of the app runtime, for the window's servers, which run
 * outside that runtime: the install quiesce disposes it in the middle of the
 * call that asked for the install (src/app/update/ipc.ts).
 */
const appUpdateService = Layer.effect(
  UpdateService,
  Effect.promise(() => AppRuntime.runPromise(Effect.gen(function* () {
    return yield* UpdateService;
  }))),
);

export const windowHandlers = (boot: {
  readonly currentVersion: string;
  readonly install: UpdateInstall;
  readonly core: Context.Context<CoreClients>;
}): WindowHandlers =>
  Layer.mergeAll(updateWindowHandlers(boot.currentVersion, boot.install), ReferencesWindowHandlers, ShellEnvironmentWindowHandlers).pipe(
    Layer.provide([appUpdateService, Layer.succeedContext(boot.core)]),
  );
