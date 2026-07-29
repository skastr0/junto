import { Context, Effect, Layer, Schedule, SubscriptionRef } from "effect";
import {
  decodeUpdateStatus,
  idleUpdateStatus,
  type AvailableRelease,
  type UpdateStatus,
} from "@shared/update";
import {
  bindPreflightReceipt,
  canAuthorizeInstall,
  canOperatorInstall,
  hashFileSha256,
  isMintedCandidate,
  mintAuthorizedCandidate,
  type AuthorizedUpdateCandidate,
} from "./domain";
import { UpdateError, updateError } from "./errors";
import { runCandidateStatePreflight } from "./preflight-runner";
import type { UpdateHostHooks, UpdateProvider } from "./provider";
import { expandMacUpdateZip, releaseStaging } from "./staging";

export class UpdateService extends Context.Tag("@vellum/UpdateService")<
  UpdateService,
  {
    readonly getState: Effect.Effect<UpdateStatus>;
    readonly check: Effect.Effect<UpdateStatus, UpdateError>;
    /**
     * Validate the exact downloaded candidate and enter installing.
     * Does not quiesce SQLite or run preflight — host does that, then
     * `finalizeInstallAfterQuiesce`.
     */
    readonly prepareInstall: Effect.Effect<
      {
        readonly plan: InstallPlan;
        readonly candidate: AuthorizedUpdateCandidate;
      },
      UpdateError
    >;
    /**
     * Full operator path when host.quiesce does not dispose this service
     * (tests / no-op quiesce). Production IPC splits prepare + finalize.
     */
    readonly restartAndInstall: Effect.Effect<UpdateStatus, UpdateError>;
    readonly subscribe: (
      listener: (status: UpdateStatus) => void,
    ) => () => void;
  }
>() {}

/** Sealed install plan — only prepareInstall mints these. */
export type InstallPlan = {
  readonly version: string;
  readonly downloadedFile: string;
  readonly zipSha256: string;
  readonly executablePath: string;
  readonly stagingRoot: string | undefined;
  readonly available: AvailableRelease | undefined;
  readonly currentVersion: string;
};

const installPlans = new WeakSet<object>();

export const isMintedInstallPlan = (
  plan: InstallPlan | undefined,
): plan is InstallPlan => plan !== undefined && installPlans.has(plan);

export type UpdateServiceOptions = {
  readonly currentVersion: string;
  readonly provider: UpdateProvider;
  readonly host: UpdateHostHooks;
  readonly expandZip?: typeof expandMacUpdateZip;
  readonly runPreflight?: typeof runCandidateStatePreflight;
};

type LiveState = {
  readonly status: UpdateStatus;
  readonly candidate: AuthorizedUpdateCandidate | undefined;
  readonly stagingRoot: string | undefined;
  readonly installInFlight: boolean;
};

const BUSY_PHASES = new Set(["ready", "downloading", "installing"]);

const projectStatus = (
  base: Omit<UpdateStatus, "canInstall"> & {
    readonly canInstall?: boolean;
  },
  candidate: AuthorizedUpdateCandidate | undefined,
): UpdateStatus => {
  // Schema.optionalWith({ exact: true }) rejects explicit undefined — strip
  // optional keys that are still unset before decoding.
  const cleaned: Record<string, unknown> = {
    phase: base.phase,
    currentVersion: base.currentVersion,
    // Operator Restart affordance once staged app is admitted+minted.
    canInstall: canOperatorInstall(candidate),
  };
  if (base.available !== undefined) cleaned.available = base.available;
  if (base.progress !== undefined) cleaned.progress = base.progress;
  if (base.error !== undefined) cleaned.error = base.error;
  if (base.lastCheckedAt !== undefined) {
    cleaned.lastCheckedAt = base.lastCheckedAt;
  }
  return decodeUpdateStatus(cleaned);
};

/**
 * Post-quiesce finalize: preflight the exact candidate, bind receipt to ZIP
 * digest, then quitAndInstall. Safe to run with Effect.runPromise after
 * AppRuntime.dispose (no UpdateService dependency).
 */
export const finalizeInstallAfterQuiesce = (input: {
  readonly plan: InstallPlan;
  readonly provider: UpdateProvider;
  readonly host: UpdateHostHooks;
  readonly candidate: AuthorizedUpdateCandidate;
  readonly runPreflight?: typeof runCandidateStatePreflight;
}): Effect.Effect<UpdateStatus, UpdateError> =>
  Effect.gen(function* () {
    if (!isMintedInstallPlan(input.plan)) {
      return yield* Effect.fail(
        updateError(
          "install-refused",
          "install plan was not minted by prepareInstall",
        ),
      );
    }
    if (!isMintedCandidate(input.candidate)) {
      return yield* Effect.fail(
        updateError(
          "candidate-mismatch",
          "install candidate was not minted by the update coordinator",
        ),
      );
    }
    if (input.candidate.zipSha256 !== input.plan.zipSha256) {
      return yield* Effect.fail(
        updateError(
          "candidate-mismatch",
          "install plan zip digest does not match minted candidate",
        ),
      );
    }

    const runPreflight = input.runPreflight ?? runCandidateStatePreflight;
    const receipt = yield* runPreflight({
      executablePath: input.plan.executablePath,
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          input.host.relaunchWithoutInstall();
        }),
      ),
    );

    const bound = yield* bindPreflightReceipt(
      input.candidate,
      receipt,
      input.plan.zipSha256,
    ).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          input.host.relaunchWithoutInstall();
        }),
      ),
    );
    if (!canAuthorizeInstall(bound)) {
      input.host.relaunchWithoutInstall();
      return yield* Effect.fail(
        updateError(
          "install-refused",
          "preflight receipt did not authorize this candidate",
        ),
      );
    }

    yield* releaseStaging(input.plan.stagingRoot);
    yield* Effect.try({
      try: () => {
        input.provider.quitAndInstall();
      },
      catch: (cause) => {
        input.host.relaunchWithoutInstall();
        return updateError(
          "install-refused",
          cause instanceof Error
            ? `quitAndInstall failed: ${cause.message}`
            : "quitAndInstall failed",
          cause,
        );
      },
    });

    return projectStatus(
      {
        phase: "installing",
        currentVersion: input.plan.currentVersion,
        ...(input.plan.available === undefined
          ? {}
          : { available: input.plan.available }),
      },
      bound,
    );
  }).pipe(Effect.withSpan("update.finalize-install"));

export const makeUpdateService = (
  options: UpdateServiceOptions,
): Effect.Effect<Context.Tag.Service<typeof UpdateService>> =>
  Effect.gen(function* () {
    const initial: LiveState = {
      status: idleUpdateStatus(options.currentVersion),
      candidate: undefined,
      stagingRoot: undefined,
      installInFlight: false,
    };
    const ref = yield* SubscriptionRef.make(initial);
    const listeners = new Set<(status: UpdateStatus) => void>();
    const expandZip = options.expandZip ?? expandMacUpdateZip;
    const runPreflight = options.runPreflight ?? runCandidateStatePreflight;

    // Serial provider-event queue — prevent concurrent Effect.runPromise races.
    let eventChain: Promise<void> = Promise.resolve();
    const enqueueProviderEvent = (work: Effect.Effect<void>): void => {
      eventChain = eventChain
        .then(() =>
          Effect.runPromise(work).then(
            () => undefined,
            () => undefined,
          ),
        )
        .catch(() => undefined);
    };

    const publish = (next: LiveState): Effect.Effect<UpdateStatus> =>
      Effect.gen(function* () {
        yield* SubscriptionRef.set(ref, next);
        for (const listener of listeners) {
          try {
            listener(next.status);
          } catch {
            // renderer listeners must not break the update coordinator
          }
        }
        return next.status;
      });

    const read = (): Effect.Effect<LiveState> => SubscriptionRef.get(ref);

    const setStatus = (
      patch: (current: LiveState) => LiveState,
    ): Effect.Effect<UpdateStatus> =>
      Effect.gen(function* () {
        const current = yield* read();
        return yield* publish(patch(current));
      });

    const onProviderEvent = (
      event: Parameters<Parameters<UpdateProvider["start"]>[0]>[0],
    ): void => {
      enqueueProviderEvent(
        Effect.gen(function* () {
          const current = yield* read();
          if (current.installInFlight) return;

          switch (event._tag) {
            case "checking": {
              yield* setStatus((state) => ({
                ...state,
                status: projectStatus(
                  {
                    phase: "checking",
                    currentVersion: options.currentVersion,
                    lastCheckedAt: state.status.lastCheckedAt,
                    ...(state.status.available === undefined
                      ? {}
                      : { available: state.status.available }),
                  },
                  state.candidate,
                ),
              }));
              return;
            }
            case "available": {
              yield* setStatus((state) => ({
                ...state,
                status: projectStatus(
                  {
                    phase: "available",
                    currentVersion: options.currentVersion,
                    available: event.release,
                    lastCheckedAt: new Date().toISOString(),
                  },
                  state.candidate,
                ),
              }));
              return;
            }
            case "not-available": {
              yield* setStatus((state) => ({
                ...state,
                candidate: undefined,
                status: projectStatus(
                  {
                    phase: "idle",
                    currentVersion: options.currentVersion,
                    lastCheckedAt: new Date().toISOString(),
                  },
                  undefined,
                ),
              }));
              return;
            }
            case "progress": {
              yield* setStatus((state) => ({
                ...state,
                status: projectStatus(
                  {
                    phase: "downloading",
                    currentVersion: options.currentVersion,
                    ...(state.status.available === undefined
                      ? {}
                      : { available: state.status.available }),
                    progress: event.progress,
                    lastCheckedAt: state.status.lastCheckedAt,
                  },
                  state.candidate,
                ),
              }));
              return;
            }
            case "downloaded": {
              const zipSha256 = yield* hashFileSha256(event.downloadedFile);
              let executablePath: string | undefined;
              let stagingRoot: string | undefined;
              if (options.provider.kind === "mac") {
                const staged = yield* expandZip(event.downloadedFile);
                executablePath = staged.executablePath;
                stagingRoot = staged.stagingRoot;
              }
              const candidate = mintAuthorizedCandidate({
                version: event.release.version,
                downloadedFile: event.downloadedFile,
                zipSha256,
                ...(executablePath === undefined
                  ? {}
                  : { stagedAppPath: executablePath }),
              });
              if (current.stagingRoot !== undefined) {
                yield* releaseStaging(current.stagingRoot);
              }
              yield* setStatus(() => ({
                candidate,
                stagingRoot,
                installInFlight: false,
                status: projectStatus(
                  {
                    phase: "ready",
                    currentVersion: options.currentVersion,
                    available: event.release,
                    lastCheckedAt: new Date().toISOString(),
                  },
                  candidate,
                ),
              }));
              return;
            }
            case "error": {
              const code =
                options.provider.kind === "linux" ||
                options.provider.kind === "unsupported"
                  ? ("platform-unsupported" as const)
                  : event.message.includes("packaged")
                    ? ("not-packaged" as const)
                    : ("check-failed" as const);
              yield* setStatus((state) => ({
                ...state,
                status: projectStatus(
                  {
                    phase: "error",
                    currentVersion: options.currentVersion,
                    ...(state.status.available === undefined
                      ? {}
                      : { available: state.status.available }),
                    error: { code, message: event.message },
                    lastCheckedAt: new Date().toISOString(),
                  },
                  state.candidate,
                ),
              }));
              return;
            }
          }
        }).pipe(
          Effect.catchAll((error) =>
            setStatus((state) => ({
              ...state,
              status: projectStatus(
                {
                  phase: "error",
                  currentVersion: options.currentVersion,
                  ...(state.status.available === undefined
                    ? {}
                    : { available: state.status.available }),
                  error: {
                    code:
                      error instanceof UpdateError
                        ? error.updateCode
                        : "unknown",
                    message:
                      error instanceof Error
                        ? error.message
                        : "update coordinator failed",
                  },
                },
                state.candidate,
              ),
            })).pipe(Effect.asVoid),
          ),
          Effect.asVoid,
        ),
      );
    };

    options.provider.start(onProviderEvent);

    const getState: Effect.Effect<UpdateStatus> = Effect.map(
      read(),
      (state) => state.status,
    );

    const check: Effect.Effect<UpdateStatus, UpdateError> = Effect.gen(
      function* () {
        const current = yield* read();
        if (current.installInFlight) {
          return current.status;
        }
        // Skip scheduled/operator check while download/ready/install is live.
        if (BUSY_PHASES.has(current.status.phase)) {
          return current.status;
        }
        yield* Effect.tryPromise({
          try: () => options.provider.check(),
          catch: (cause) =>
            updateError(
              "check-failed",
              cause instanceof Error
                ? cause.message
                : "update check failed",
              cause,
            ),
        });
        return (yield* read()).status;
      },
    );

    const prepareInstall: Effect.Effect<
      {
        readonly plan: InstallPlan;
        readonly candidate: AuthorizedUpdateCandidate;
      },
      UpdateError
    > = Effect.gen(function* () {
      const current = yield* read();
      if (current.installInFlight) {
        return yield* Effect.fail(
          updateError("not-ready", "an install is already in flight"),
        );
      }
      if (!isMintedCandidate(current.candidate)) {
        return yield* Effect.fail(
          updateError(
            "not-ready",
            "no exact downloaded candidate is ready to install",
          ),
        );
      }
      if (current.candidate.stagedAppPath === undefined) {
        return yield* Effect.fail(
          updateError(
            "not-ready",
            "candidate was not expanded for readiness proof",
          ),
        );
      }

      const candidate = current.candidate;
      const executablePath = candidate.stagedAppPath;
      if (executablePath === undefined) {
        return yield* Effect.fail(
          updateError(
            "not-ready",
            "candidate was not expanded for readiness proof",
          ),
        );
      }
      const zipSha256 = yield* hashFileSha256(candidate.downloadedFile);
      if (zipSha256 !== candidate.zipSha256) {
        const staleStaging = current.stagingRoot;
        yield* releaseStaging(staleStaging);
        yield* setStatus((state) => ({
          ...state,
          candidate: undefined,
          stagingRoot: undefined,
          status: projectStatus(
            {
              phase: "error",
              currentVersion: options.currentVersion,
              error: {
                code: "candidate-mismatch",
                message:
                  "downloaded update ZIP changed after readiness mint",
              },
            },
            undefined,
          ),
        }));
        return yield* Effect.fail(
          updateError(
            "candidate-mismatch",
            "downloaded update ZIP changed after readiness mint",
          ),
        );
      }

      yield* setStatus((state) => ({
        ...state,
        installInFlight: true,
        status: projectStatus(
          {
            phase: "installing",
            currentVersion: options.currentVersion,
            ...(state.status.available === undefined
              ? {}
              : { available: state.status.available }),
            lastCheckedAt: state.status.lastCheckedAt,
          },
          state.candidate,
        ),
      }));

      const plan: InstallPlan = {
        version: candidate.version,
        downloadedFile: candidate.downloadedFile,
        zipSha256,
        executablePath,
        stagingRoot: current.stagingRoot,
        available: current.status.available,
        currentVersion: options.currentVersion,
      };
      installPlans.add(plan);
      return { plan, candidate };
    });

    const restartAndInstall: Effect.Effect<UpdateStatus, UpdateError> =
      Effect.gen(function* () {
        const prepared = yield* prepareInstall;

        yield* Effect.tryPromise({
          try: () => options.host.quiesceForPreflight(),
          catch: (cause) =>
            updateError(
              "readiness-failed",
              cause instanceof Error
                ? `failed to quiesce for preflight: ${cause.message}`
                : "failed to quiesce for preflight",
              cause,
            ),
        });

        return yield* finalizeInstallAfterQuiesce({
          plan: prepared.plan,
          provider: options.provider,
          host: options.host,
          candidate: prepared.candidate,
          runPreflight,
        });
      }).pipe(
        Effect.catchAll((error: UpdateError) =>
          Effect.gen(function* () {
            yield* setStatus((state) => ({
              ...state,
              installInFlight: false,
              status: projectStatus(
                {
                  phase: "error",
                  currentVersion: options.currentVersion,
                  ...(state.status.available === undefined
                    ? {}
                    : { available: state.status.available }),
                  error: {
                    code: error.updateCode,
                    message: error.message,
                  },
                },
                state.candidate,
              ),
            }));
            return yield* Effect.fail(error);
          }),
        ),
      );

    return UpdateService.of({
      getState,
      check,
      prepareInstall,
      restartAndInstall,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
  });

/**
 * Join the application ManagedRuntime as a scoped coordinator.
 * Background checks: ~30s after startup, then every six hours.
 * Network failures stay quiet (Effect.ignore) and retry on the next tick.
 * Skips when phase is ready|downloading|installing (see check()).
 */
export const makeUpdateServiceLayer = (
  options: UpdateServiceOptions,
): Layer.Layer<UpdateService> =>
  Layer.scoped(
    UpdateService,
    Effect.gen(function* () {
      const service = yield* makeUpdateService(options);
      // Quiet scheduled checks — only packaged Mac produces real events.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Effect.sleep("30 seconds");
          yield* service.check.pipe(Effect.ignore);
          yield* Effect.repeat(
            service.check.pipe(Effect.ignore),
            Schedule.spaced("6 hours"),
          );
        }),
      );
      return service;
    }),
  );
