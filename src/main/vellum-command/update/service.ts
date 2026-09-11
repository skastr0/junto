import { Context, Effect, Layer, Schedule, SubscriptionRef } from "effect";
import {
  decodeUpdateStatus,
  idleUpdateStatus,
  type AvailableRelease,
  type UpdateInstallProvenance,
  type UpdateStatus,
} from "@shared/update";
import {
  canAuthorizeInstall,
  canOperatorInstall,
  hashFileSha256,
  isMintedCandidate,
  mintAuthorizedCandidate,
  type AuthorizedUpdateCandidate,
} from "./domain";
import { UpdateError, updateError } from "./errors";
import type { StagedUpdate, UpdateHostHooks, UpdateProvider } from "./provider";
import { releaseStaging } from "./staging";

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/UpdateService` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class UpdateService extends Context.Service<UpdateService, UpdateService>()("@vellum-command/UpdateService") {}`
 * - Layer today: makeUpdateServiceLayer — V4 rename candidate UpdateService.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class UpdateService extends Context.Service<UpdateService,
  {
    readonly getState: Effect.Effect<UpdateStatus>;
    readonly check: Effect.Effect<UpdateStatus, UpdateError>;
    /**
     * Validate the exact downloaded candidate and enter installing.
     * Does not quiesce SQLite — host does that, then
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
  }>()("@vellum-command/UpdateService") {}

/** Sealed install plan — only prepareInstall mints these. */
export type InstallPlan = {
  readonly version: string;
  readonly downloadedFile: string;
  readonly archiveSha256: string;
  readonly executablePath: string;
  readonly stagingRoot: string | undefined;
  readonly available: AvailableRelease | undefined;
  readonly currentVersion: string;
};

const installPlans = new WeakMap<object, AuthorizedUpdateCandidate>();

export const isMintedInstallPlan = (
  plan: InstallPlan | undefined,
): plan is InstallPlan => plan !== undefined && installPlans.has(plan);

export type UpdateServiceOptions = {
  readonly currentVersion: string;
  readonly provider: UpdateProvider;
  readonly host: UpdateHostHooks;
  /** Operator-visible install identity; mirrored onto every projected status. */
  readonly install?: UpdateInstallProvenance;
  readonly stageDownloaded?: (downloadedFile: string, release: AvailableRelease) => Effect.Effect<StagedUpdate, UpdateError>;
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
  install: UpdateInstallProvenance | undefined,
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
  if (install !== undefined) cleaned.install = install;
  return decodeUpdateStatus(cleaned);
};

/**
 * Post-quiesce finalize: authorize the exact minted staged candidate, then
 * quitAndInstall. Schema+data migration runs on normal app open. Safe to run
 * with Effect.runPromise after AppRuntime.dispose (no UpdateService dependency).
 */
export const finalizeInstallAfterQuiesce = (input: {
  readonly plan: InstallPlan;
  readonly provider: UpdateProvider;
  readonly host: UpdateHostHooks;
  readonly candidate: AuthorizedUpdateCandidate;
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
    if (installPlans.get(input.plan) !== input.candidate || input.candidate.archiveSha256 !== input.plan.archiveSha256) {
      return yield* Effect.fail(
        updateError(
          "candidate-mismatch",
          "install plan does not match its exact minted candidate",
        ),
      );
    }
    if (!canAuthorizeInstall(input.candidate)) {
      input.host.relaunchWithoutInstall();
      return yield* Effect.fail(
        updateError(
          "install-refused",
          "candidate is not authorized for install",
        ),
      );
    }
    // Consume once before the external cutover; a retry needs fresh admission.
    installPlans.delete(input.plan);

    yield* releaseStaging(input.plan.stagingRoot);
    yield* Effect.tryPromise({
      try: async () => {
        if (input.candidate.installation?.installAfterQuiesce !== undefined) {
          await input.candidate.installation.installAfterQuiesce(input.host);
        } else {
          input.provider.quitAndInstall();
        }
      },
      catch: (cause) => {
        const activated = input.candidate.installation?.hasActivated?.() === true;
        if (!activated) input.host.relaunchWithoutInstall();
        return updateError(
          "install-refused",
          activated
            ? "The new release was activated but could not restart. Quit and launch Vellum Command from its installed desktop launcher; the previous release cannot be restored."
            : cause instanceof Error
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
      input.candidate,
      undefined,
    );
  }).pipe(Effect.withSpan("update.finalize-install"));

export const makeUpdateService = (
  options: UpdateServiceOptions,
): Effect.Effect<Context.Service.Shape<typeof UpdateService>> =>
  Effect.gen(function* () {
    const install = options.install;
    const statusOf = (
      base: Omit<UpdateStatus, "canInstall"> & {
        readonly canInstall?: boolean;
      },
      candidate: AuthorizedUpdateCandidate | undefined,
    ): UpdateStatus => projectStatus(base, candidate, install);

    const initial: LiveState = {
      status: idleUpdateStatus(options.currentVersion, install),
      candidate: undefined,
      stagingRoot: undefined,
      installInFlight: false,
    };
    const ref = yield* SubscriptionRef.make(initial);
    const listeners = new Set<(status: UpdateStatus) => void>();
    const stageDownloaded = options.stageDownloaded ?? ((downloadedFile: string, release: AvailableRelease) =>
      Effect.tryPromise({
        try: async () => {
          if (options.provider.stageDownloaded === undefined) {
            throw new Error("update provider has no staged artifact admission");
          }
          return options.provider.stageDownloaded(downloadedFile, release);
        },
        catch: (cause) => cause instanceof UpdateError ? cause : updateError(
          "readiness-failed", cause instanceof Error ? cause.message : "update admission failed", cause,
        ),
      }));
    const runtime = yield* Effect.context<never>();

    // Serial provider-event queue — prevent concurrent runPromiseWith races.
    let eventChain: Promise<void> = Promise.resolve();
    const enqueueProviderEvent = (work: Effect.Effect<void>): void => {
      eventChain = eventChain
        .then(() =>
          Effect.runPromiseWith(runtime)(work).then(
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
                status: statusOf(
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
                status: statusOf(
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
                status: statusOf(
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
                status: statusOf(
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
              const archiveSha256 = yield* hashFileSha256(event.downloadedFile);
              const staged = yield* stageDownloaded(event.downloadedFile, event.release);
              const executablePath = staged.executablePath;
              const stagingRoot = staged.stagingRoot;
              const candidate = mintAuthorizedCandidate({
                version: event.release.version,
                downloadedFile: event.downloadedFile,
                archiveSha256,
                installation: staged,
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
                status: statusOf(
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
              const code = event.code ?? (event.message.includes("packaged")
                    ? ("not-packaged" as const)
                    : ("check-failed" as const));
              yield* setStatus((state) => ({
                ...state,
                status: statusOf(
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
          Effect.catch((error) =>
            setStatus((state) => ({
              ...state,
              status: statusOf(
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
      const archiveSha256 = yield* hashFileSha256(candidate.downloadedFile);
      if (archiveSha256 !== candidate.archiveSha256) {
        const staleStaging = current.stagingRoot;
        yield* releaseStaging(staleStaging);
        yield* setStatus((state) => ({
          ...state,
          candidate: undefined,
          stagingRoot: undefined,
          status: statusOf(
            {
              phase: "error",
              currentVersion: options.currentVersion,
              error: {
                code: "candidate-mismatch",
                message:
                  "downloaded update archive changed after readiness mint",
              },
            },
            undefined,
          ),
        }));
        return yield* Effect.fail(
          updateError(
            "candidate-mismatch",
            "downloaded update archive changed after readiness mint",
          ),
        );
      }

      if (candidate.installation?.revalidate !== undefined) {
        yield* Effect.tryPromise({
          try: candidate.installation.revalidate,
          catch: (cause) => updateError("candidate-mismatch",
            cause instanceof Error ? cause.message : "staged update changed after admission", cause),
        }).pipe(Effect.tapError((error) => setStatus((state) => ({
          ...state,
          candidate: undefined,
          status: statusOf({ phase: "error", currentVersion: options.currentVersion,
            error: { code: error.updateCode, message: error.message } }, undefined),
        }))));
      }

      yield* setStatus((state) => ({
        ...state,
        installInFlight: true,
        status: statusOf(
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

      const plan: InstallPlan = Object.freeze({
        version: candidate.version,
        downloadedFile: candidate.downloadedFile,
        archiveSha256,
        executablePath,
        stagingRoot: current.stagingRoot,
        available: current.status.available,
        currentVersion: options.currentVersion,
      });
      installPlans.set(plan, candidate);
      return { plan, candidate };
    });

    const restartAndInstall: Effect.Effect<UpdateStatus, UpdateError> =
      Effect.gen(function* () {
        const prepared = yield* prepareInstall;

        yield* Effect.tryPromise({
          try: () => options.host.quiesceForInstall(),
          catch: (cause) =>
            updateError(
              "readiness-failed",
              cause instanceof Error
                ? `failed to quiesce for install: ${cause.message}`
                : "failed to quiesce for install",
              cause,
            ),
        });

        return yield* finalizeInstallAfterQuiesce({
          plan: prepared.plan,
          provider: options.provider,
          host: options.host,
          candidate: prepared.candidate,
        });
      }).pipe(
        Effect.catch((error: UpdateError) =>
          Effect.gen(function* () {
            yield* setStatus((state) => ({
              ...state,
              installInFlight: false,
              candidate: state.candidate?.installation?.hasActivated?.() === true ? undefined : state.candidate,
              status: statusOf(
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
                state.candidate?.installation?.hasActivated?.() === true ? undefined : state.candidate,
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
  Layer.effect(
    UpdateService,
    Effect.gen(function* () {
      const service = yield* makeUpdateService(options);
      yield* Effect.addFinalizer(() => Effect.sync(() => options.provider.stop()));
      // Quiet scheduled checks for packaged desktop releases.
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
