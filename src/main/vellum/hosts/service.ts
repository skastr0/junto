import { Context, Effect, Either, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import {
  defaultRemoteHostsDocument,
  RemoteHost,
  RemoteHostsError,
  type RemoteHost as RemoteHostT,
} from "@shared/remote-hosts";
import {
  MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
} from "@shared/release-capabilities";
import { SshTransport } from "../ssh";
import {
  configureRemoteHost,
  type ConfigureRemoteOptions,
  type ConfigureRemoteResult,
} from "./configure-remote";
import {
  deployRemoteHost,
  type DeployRemoteResult,
  type RemoteDeploymentAuthorization,
} from "./deploy-remote";
import {
  deployConfiguredRemoteHost,
  type ConfiguredRemoteDeployResult,
} from "./deploy-configured-remote";
import {
  runRemoteHostsDoctor,
  runRemoteHostsDoctorSnapshot,
  testHostConnection,
  type RemoteHostsDoctorSnapshot,
} from "./doctor";
import {
  getDefaultHostsRegistry,
  type HostsRegistry,
} from "./registry";
import { setHostsSnapshot } from "./snapshot";
import { StateEngine } from "../state/service";

const decodeHost = Schema.decodeUnknownEither(RemoteHost);

export type { ConfigureRemoteResult, DeployRemoteResult };

export class HostsService extends Context.Tag("@vellum/HostsService")<
  HostsService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    /** One SSH pass shared by fleet Doctor and Station projection. */
    readonly doctorSnapshot: Effect.Effect<RemoteHostsDoctorSnapshot>;
    readonly list: Effect.Effect<ReadonlyArray<RemoteHostT>, RemoteHostsError>;
    readonly get: (
      id: string,
    ) => Effect.Effect<RemoteHostT | undefined, RemoteHostsError>;
    readonly upsert: (
      input: unknown,
    ) => Effect.Effect<ReadonlyArray<RemoteHostT>, RemoteHostsError>;
    readonly remove: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<RemoteHostT>, RemoteHostsError>;
    readonly test: (
      id: string,
    ) => Effect.Effect<
      {
        readonly ok: boolean;
        readonly detail: string;
        readonly reachability?: "reachable" | "unreachable" | "unknown";
      },
      RemoteHostsError
    >;
    /** Command Center → SSH stamp Remote station fields on a registered remote host. */
    readonly configureRemote: (
      id: string,
      options: ConfigureRemoteOptions,
    ) => Effect.Effect<ConfigureRemoteResult, RemoteHostsError>;
    /** Command Center → install/update .app over SSH + start Remote station. */
    readonly deployRemote: (
      id: string,
      authorization?: RemoteDeploymentAuthorization,
    ) => Effect.Effect<DeployRemoteResult>;
    /** Configure + deploy under one per-host compensating transaction. */
    readonly deployConfiguredRemote: (
      id: string,
      options: ConfigureRemoteOptions & {
        readonly authorization?: RemoteDeploymentAuthorization;
        /**
         * Durable admission barrier run after registry resolution and before
         * any remote mutation. A failure prevents the deployment from starting.
         */
        readonly onAdmitted?: (
          host: RemoteHostT,
        ) => Effect.Effect<void, RemoteHostsError>;
        /** Final receipt barrier; runs under the same endpoint semaphore. */
        readonly onCompleted?: (
          host: RemoteHostT,
          result: ConfiguredRemoteDeployResult,
        ) => Effect.Effect<void, RemoteHostsError>;
      },
    ) => Effect.Effect<ConfiguredRemoteDeployResult>;
    readonly path: () => string;
  }
>() {}

const asRemoteHostsError = (error: unknown): RemoteHostsError =>
  error instanceof RemoteHostsError
    ? error
    : new RemoteHostsError(
        "io",
        error instanceof Error ? error.message : String(error),
      );

const loadHostsIntoRoutingSnapshot = (
  load: () => Promise<ReadonlyArray<RemoteHostT>>,
): Effect.Effect<ReadonlyArray<RemoteHostT>, RemoteHostsError> =>
  Effect.tryPromise({
    try: load,
    catch: asRemoteHostsError,
  }).pipe(
    Effect.tap((hosts) =>
      Effect.sync(() => {
        setHostsSnapshot(hosts);
      }),
    ),
  );

export const makeHostsService = (
  registry: HostsRegistry,
  ssh: Context.Tag.Service<typeof SshTransport>,
  operations: {
    readonly configureRemoteHost: typeof configureRemoteHost;
    readonly deployRemoteHost: typeof deployRemoteHost;
    readonly deployConfiguredRemoteHost: typeof deployConfiguredRemoteHost;
  } = {
    configureRemoteHost,
    deployRemoteHost,
    deployConfiguredRemoteHost,
  },
): Context.Tag.Service<typeof HostsService> => {
  const mutationLocks = new Map<string, Effect.Semaphore>();
  const mutationTarget = (host: RemoteHostT): string =>
    host.kind === "remote" && host.endpoint
      ? `remote:${host.endpoint}`
      : `local:${host.id}`;
  const mutationLockFor = (target: string): Effect.Semaphore => {
    const existing = mutationLocks.get(target);
    if (existing) return existing;
    const created = Effect.unsafeMakeSemaphore(1);
    mutationLocks.set(target, created);
    return created;
  };
  const serializeHostMutation = <A, E, R>(
    host: RemoteHostT,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    mutationLockFor(mutationTarget(host)).withPermits(1)(effect);

  return {
    path: () => registry.path(),
    doctor: runRemoteHostsDoctor(registry, ssh),
    doctorSnapshot: runRemoteHostsDoctorSnapshot(registry, ssh),
    // Listing is the explicit durable reload boundary used by Settings and IPC.
    // Keep the synchronous routing snapshot in the same successful operation.
    list: loadHostsIntoRoutingSnapshot(() => registry.reload()),
    get: (id) =>
      Effect.tryPromise({
        try: () => registry.get(id),
        catch: asRemoteHostsError,
      }),
    upsert: (input) =>
      Effect.gen(function* () {
        const decoded = decodeHost(input);
        if (Either.isLeft(decoded)) {
          return yield* Effect.fail(
            new RemoteHostsError(
              "validation",
              `invalid host: ${decoded.left.message}`,
            ),
          );
        }
        const hosts = yield* Effect.tryPromise({
          try: () => registry.upsert(decoded.right),
          catch: asRemoteHostsError,
        });
        setHostsSnapshot(hosts);
        return hosts;
      }).pipe(Effect.uninterruptible),
    remove: (id) =>
      Effect.gen(function* () {
        const hosts = yield* Effect.tryPromise({
          try: () => registry.remove(id),
          catch: asRemoteHostsError,
        });
        setHostsSnapshot(hosts);
        return hosts;
      }).pipe(Effect.uninterruptible),
    test: (id) =>
      Effect.gen(function* () {
        const host = yield* Effect.tryPromise({
          try: () => registry.get(id),
          catch: asRemoteHostsError,
        });
        if (!host) {
          return yield* Effect.fail(
            new RemoteHostsError("not_found", `unknown host: ${id}`),
          );
        }
        return yield* testHostConnection(ssh, host);
      }),
    configureRemote: (id, options) =>
      Effect.gen(function* () {
        const host = yield* Effect.tryPromise({
          try: () => registry.get(id),
          catch: asRemoteHostsError,
        });
        if (!host) {
          return yield* Effect.fail(
            new RemoteHostsError("not_found", `unknown host: ${id}`),
          );
        }
        return yield* serializeHostMutation(
          host,
          operations.configureRemoteHost(ssh, host, options),
        );
      }),
    deployRemote: (id, authorization) =>
      Effect.gen(function* () {
        if (!RELEASE_CAPABILITIES.managedRemoteDeploy) {
          return {
            ok: false,
            detail: MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
            code: "validation" as const,
            stages: [],
          } satisfies DeployRemoteResult;
        }
        const hostResult = yield* Effect.either(
          Effect.tryPromise({
            try: () => registry.get(id),
            catch: asRemoteHostsError,
          }),
        );
        if (hostResult._tag === "Left") {
          return {
            ok: false,
            detail: hostResult.left.message,
            code: hostResult.left.code,
            stages: [],
          } satisfies DeployRemoteResult;
        }
        const host = hostResult.right;
        if (!host) {
          return {
            ok: false,
            detail: `unknown host: ${id}`,
            code: "not_found" as const,
            stages: [],
          } satisfies DeployRemoteResult;
        }
        return yield* serializeHostMutation(
          host,
          operations.deployRemoteHost(ssh, host, authorization),
        );
      }),
    deployConfiguredRemote: (id, options) =>
      Effect.gen(function* () {
        if (!RELEASE_CAPABILITIES.managedRemoteDeploy) {
          return {
            ok: false,
            detail: MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
            code: "validation" as const,
            message: MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
            hostResolved: false,
            stages: [],
            disposition: "not-started" as const,
            outcome: "failed" as const,
            packageState: "previous" as const,
            role: "previous" as const,
            rollback: "not-required" as const,
            configuration: {
              ok: false,
              detail: MANAGED_REMOTE_DEPLOY_DISABLED_DETAIL,
            },
          } satisfies ConfiguredRemoteDeployResult;
        }
        const hostResult = yield* Effect.either(
          Effect.tryPromise({
            try: () => registry.get(id),
            catch: asRemoteHostsError,
          }),
        );
        if (hostResult._tag === "Left") {
          return {
            ok: false,
            detail: hostResult.left.message,
            code: hostResult.left.code,
            message: hostResult.left.message,
            hostResolved: false,
            stages: [],
            disposition: "not-started" as const,
            outcome: "failed" as const,
            packageState: "previous" as const,
            role: "previous" as const,
            rollback: "not-required" as const,
            configuration: { ok: false, detail: hostResult.left.message },
          } satisfies ConfiguredRemoteDeployResult;
        }
        const host = hostResult.right;
        if (!host) {
          const detail = `unknown host: ${id}`;
          return {
            ok: false,
            detail,
            code: "not_found" as const,
            message: detail,
            hostResolved: false,
            stages: [],
            disposition: "not-started" as const,
            outcome: "failed" as const,
            packageState: "previous" as const,
            role: "previous" as const,
            rollback: "not-required" as const,
            configuration: { ok: false, detail },
          } satisfies ConfiguredRemoteDeployResult;
        }
        return yield* serializeHostMutation(
          host,
          Effect.gen(function* () {
            if (options.onAdmitted) {
              const admission = yield* options.onAdmitted(host).pipe(
                Effect.either,
              );
              if (admission._tag === "Left") {
                const detail = `${host.label}: deployment did not start because its durable admission receipt could not be persisted — ${admission.left.message}`;
                return {
                  ok: false,
                  detail,
                  code: admission.left.code,
                  message: detail,
                  hostEndpoint: host.endpoint,
                  stages: [],
                  disposition: "not-started" as const,
                  outcome: "failed" as const,
                  packageState: "previous" as const,
                  role: "previous" as const,
                  rollback: "not-required" as const,
                  statusRecorded: false,
                  configuration: { ok: false, detail },
                } satisfies ConfiguredRemoteDeployResult;
              }
            }
            const deployed = yield* operations.deployConfiguredRemoteHost(
              ssh,
              host,
              options,
            );
            if (!options.onCompleted) return deployed;
            const completion = yield* options
              .onCompleted(host, deployed)
              .pipe(Effect.either);
            if (completion._tag === "Right") {
              return {
                ...deployed,
                statusRecorded: true,
              } satisfies ConfiguredRemoteDeployResult;
            }
            const persistenceDetail = `local deployment receipt could not be persisted: ${completion.left.message}`;
            return {
              ...deployed,
              detail: `${deployed.detail} · ${persistenceDetail}`,
              message: deployed.message
                ? `${deployed.message} · ${persistenceDetail}`
                : `${deployed.detail} · ${persistenceDetail}`,
              statusRecorded: false,
            } satisfies ConfiguredRemoteDeployResult;
          }),
        );
      }),
  };
};

export const HostsServiceLive = Layer.effect(
  HostsService,
  Effect.gen(function* () {
    const ssh = yield* SshTransport;
    const state = yield* StateEngine;
    const registry = getDefaultHostsRegistry(state);
    // Layer acquisition is the normal-boot barrier: the persisted database is
    // visible to synchronous Herdr/Hermes routing before this layer can feed
    // either transport or plane.
    yield* loadHostsIntoRoutingSnapshot(() => registry.reload()).pipe(
      Effect.catchAll(() =>
        Effect.sync(() => {
          // A corrupt/unavailable database must not mint stale remote routing
          // or brick this-machine surfaces. Registry methods still surface the
          // typed failure while synchronous routing fails closed to local.
          setHostsSnapshot(defaultRemoteHostsDocument().hosts);
        }),
      ),
    );
    return makeHostsService(registry, ssh);
  }),
);
