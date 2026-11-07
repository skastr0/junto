/**
 * Main's handlers of the window's update group (src/contract/window/update.ts),
 * served on each window's link (src/app/window/ipc.ts).
 *
 * Restart-and-install runs in three steps, so SQLite is released before
 * quitAndInstall:
 * 1. prepareInstall, while the app runtime still holds the update service;
 * 2. the host's quiesce, which disposes that runtime and closes the database;
 * 3. finalizeInstallAfterQuiesce, which needs no runtime.
 * The window's server therefore runs outside the app runtime: a server forked
 * on it would be interrupted by step 2, the very call it is answering.
 */
import { Cause, Effect, Exit, Layer, Queue, Stream } from "effect";
import { UpdateWindowRpcs } from "../../contract/window/update";
import { decodeUpdateStatus, type AvailableRelease, type UpdateErrorCode, type UpdateStatus } from "@shared/update";
import { AppRuntime } from "../runtime";
import { UpdateError } from "./errors";
import type { UpdateInstall } from "./provider";
import { finalizeInstallAfterQuiesce, UpdateService } from "./service";
import { registerWindowLink } from "../window/ipc";
import type { IpcMain } from "electron";

const errorStatus = (
  currentVersion: string,
  code: UpdateErrorCode,
  message: string,
  available?: AvailableRelease,
): UpdateStatus =>
  decodeUpdateStatus({
    phase: "error",
    currentVersion,
    canInstall: false,
    ...(available === undefined ? {} : { available }),
    error: { code, message },
  });

/** A failed step's code and message: the update error's own, or the step's fallback code with the thrown message. */
const failureOf = (
  cause: Cause.Cause<unknown>,
  code: UpdateErrorCode,
  message: string,
): { readonly code: UpdateErrorCode; readonly message: string } => {
  const error = Cause.squash(cause);
  if (error instanceof UpdateError) return { code: error.updateCode, message: error.message };
  return { code, message: error instanceof Error ? error.message : message };
};

/** The update group's handlers, on the one update service and the install this main process offers. */
export const updateWindowHandlers = (currentVersion: string, install: UpdateInstall) =>
  UpdateWindowRpcs.toLayer(
    Effect.gen(function* () {
      const updates = yield* UpdateService;
      return {
        UpdateStates: () =>
          Stream.callback<UpdateStatus>(
            (queue) =>
              Effect.gen(function* () {
                // Subscribe before reading, and send the read only when no
                // change came in between: every change is told, so the last
                // one told is then at least as new as the read.
                let told = false;
                const unsubscribe = updates.subscribe((status) => {
                  told = true;
                  Queue.offerUnsafe(queue, status);
                });
                yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
                const current = yield* updates.getState;
                if (!told) Queue.offerUnsafe(queue, current);
              }),
            // Whole statuses: a window that falls behind skips to the latest.
            { bufferSize: 1, strategy: "sliding" },
          ),
        UpdateCheck: () =>
          updates.check.pipe(
            Effect.catch((error) => Effect.succeed(errorStatus(currentVersion, error.updateCode, error.message))),
          ),
        UpdateRestartAndInstall: () =>
          Effect.gen(function* () {
            const prepared = yield* Effect.exit(updates.prepareInstall);
            if (Exit.isFailure(prepared)) {
              const failure = failureOf(prepared.cause, "not-ready", "prepare install failed");
              return errorStatus(currentVersion, failure.code, failure.message);
            }
            const { plan, candidate } = prepared.value;
            const quiesced = yield* Effect.exit(
              Effect.tryPromise({ try: () => install.host.quiesceForInstall(), catch: (error) => error }),
            );
            if (Exit.isFailure(quiesced)) {
              const error = Cause.squash(quiesced.cause);
              install.host.relaunchWithoutInstall();
              return errorStatus(
                currentVersion,
                "readiness-failed",
                error instanceof Error ? `failed to quiesce for install: ${error.message}` : "failed to quiesce for install",
              );
            }
            const finalized = yield* Effect.exit(
              finalizeInstallAfterQuiesce({ plan, candidate, provider: install.provider, host: install.host }),
            );
            if (Exit.isSuccess(finalized)) return finalized.value;
            // finalizeInstallAfterQuiesce already relaunched on an install failure.
            const failure = failureOf(finalized.cause, "readiness-failed", "install failed");
            return errorStatus(currentVersion, failure.code, failure.message, plan.available);
          }),
      };
    }),
  );

/**
 * The update service of the app runtime, as a Layer for the window's server,
 * which runs outside that runtime (see above).
 */
const appUpdateService = Layer.effect(
  UpdateService,
  Effect.promise(() => AppRuntime.runPromise(Effect.gen(function* () {
    return yield* UpdateService;
  }))),
);

/**
 * Serves the window link with the update group, until the hub registers the
 * link with every window group itself (mailed to canvas-lead). The broadcast
 * it is handed is unused: the window follows `UpdateStates`.
 */
export const registerUpdateIpc = (
  ipcMain: IpcMain,
  _broadcast: (channel: string, payload: unknown) => void,
  currentVersion: string,
  install: UpdateInstall,
): void =>
  registerWindowLink(ipcMain, updateWindowHandlers(currentVersion, install).pipe(Layer.provide(appUpdateService)));
