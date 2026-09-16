import { Context, Effect, Result, Layer, Schema, Semaphore } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import type {
  StationProtocolObservation,
  StationRemoteObservation,
} from "@shared/station-status";
import {
  defaultRemoteHostsDocument,
  RemoteHost,
  RemoteHostsError,
  type RemoteHost as RemoteHostT,
} from "@shared/remote-hosts";
import { SshTransport, type SshTransportShape } from "../ssh";
import {
  configureRemoteHost,
  type ConfigureRemoteOptions,
  type ConfigureRemoteResult,
} from "./configure-remote";
import {
  runRemoteHostsDoctor,
  runRemoteHostsDoctorSnapshot,
  testHostConnection,
  type RemoteHostsDoctorSnapshot,
} from "./doctor";
import { StationFleetPropagation } from "../station/fleet-propagation";
import {
  getDefaultHostsRegistry,
  type HostsRegistry,
} from "./registry";
import { setHostsSnapshot } from "./snapshot";
import { StateEngine } from "../state/service";

const decodeHost = Schema.decodeUnknownResult(RemoteHost, {
  onExcessProperty: "error",
});

export type { ConfigureRemoteResult };

/**
 * S4 (effect@3.21): single canonical Tag `@junto/HostsService`.
 * `Context.Service` unavailable until Effect V4 pin — do not dual-define.
 * Shape is `HostsServiceShape`. V4 map:
 * `class HostsService extends Context.Service<HostsService, Shape>()("@junto/HostsService")`.
 * @see docs/END_STATE-effect-foundation.md §S4
 * @see Playground/effect/migration/services.md
 */
export class HostsService extends Context.Service<HostsService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    /** Observation from the one persistent fleet supervisor/session per Remote. */
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
        readonly protocol?: StationProtocolObservation;
        readonly linuxCapabilities?: import("@shared/linux-host-capabilities").LinuxHostCapabilityObservation;
        readonly observation?: StationRemoteObservation;
        readonly compatibility?: import("@shared/fleet-compatibility-snapshot").FleetPeerCompatibilitySnapshot;
      },
      RemoteHostsError
    >;
    /** Command Center → SSH stamp Remote station fields on a registered remote host. */
    readonly configureRemote: (
      id: string,
      options: ConfigureRemoteOptions,
    ) => Effect.Effect<ConfigureRemoteResult, RemoteHostsError>;
  }>()("@junto/HostsService") {}

/** Canonical service shape for `HostsService` (one id, one shape). */
export type HostsServiceShape = Context.Service.Shape<typeof HostsService>;

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
  ssh: SshTransportShape,
  fleet: Context.Service.Shape<typeof StationFleetPropagation>,
  operations: {
    readonly configureRemoteHost: typeof configureRemoteHost;
  } = {
    configureRemoteHost,
  },
): HostsServiceShape => {
  const mutationLocks = new Map<string, Semaphore.Semaphore>();
  const mutationTarget = (host: RemoteHostT): string =>
    host.kind === "remote" && host.sshEndpoint
      ? `remote:${host.sshEndpoint}`
      : `local:${host.id}`;
  const mutationLockFor = (target: string): Semaphore.Semaphore => {
    const existing = mutationLocks.get(target);
    if (existing) return existing;
    const created = Semaphore.makeUnsafe(1);
    mutationLocks.set(target, created);
    return created;
  };
  const serializeHostMutation = <A, E, R>(
    host: RemoteHostT,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    mutationLockFor(mutationTarget(host)).withPermits(1)(effect);

  return {
    doctor: runRemoteHostsDoctor(registry, ssh, fleet),
    doctorSnapshot: runRemoteHostsDoctorSnapshot(
      registry,
      ssh,
      fleet,
    ),
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
        if (Result.isFailure(decoded)) {
          return yield* Effect.fail(
            new RemoteHostsError(
              "validation",
              `invalid host: ${decoded.failure.message}`,
            ),
          );
        }
        const hosts = yield* Effect.tryPromise({
          try: () => registry.upsert(decoded.success),
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
        return yield* testHostConnection(ssh, fleet, host);
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
  };
};

export const HostsServiceLive = Layer.effect(
  HostsService,
  Effect.gen(function* () {
    const ssh = yield* SshTransport;
    const state = yield* StateEngine;
    const fleet = yield* StationFleetPropagation;
    // Capture warm ambient Context so registry Promise bridges never use bare
    // Effect.runPromise (AppRuntime / RemoteRuntime host entry).
    const runtime = yield* Effect.context<never>();
    const runPromise = <A, E>(effect: Effect.Effect<A, E, never>) =>
      Effect.runPromiseWith(runtime)(effect);
    const registry = getDefaultHostsRegistry(state, runPromise);
    // Layer acquisition is the normal-boot barrier: the persisted database is
    // visible to synchronous Hermes routing before this layer can feed
    // either transport or plane.
    yield* loadHostsIntoRoutingSnapshot(() => registry.reload()).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          // A corrupt/unavailable database must not mint stale remote routing
          // or brick this-machine surfaces. Registry methods still surface the
          // typed failure while synchronous routing fails closed to local.
          setHostsSnapshot(defaultRemoteHostsDocument().hosts);
        }),
      ),
    );
    return makeHostsService(registry, ssh, fleet);
  }),
);
