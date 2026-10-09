import { Context, Effect, Result, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ServiceCheck } from "@shared/contracts";
import {
  defaultRemoteHostsDocument,
  RemoteHost,
  RemoteHostsError,
  type RemoteHost as RemoteHostT,
} from "@shared/remote-hosts";
import { SshTransport, type SshTransportShape } from "../ssh";
import {
  runRemoteHostsDoctor,
  runRemoteHostsDoctorSnapshot,
  testHostConnection,
  type RemoteHostsDoctorSnapshot,
} from "./doctor";
import {
  getDefaultHostsRegistry,
  HostRegistryRows,
  HostsPersistence,
  type HostsRegistry,
} from "./registry";
import { setHostsSnapshot } from "./snapshot";
import { StateTransactionOperation } from "../state/service";

const decodeHost = Schema.decodeUnknownResult(RemoteHost, {
  onExcessProperty: "error",
});


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
    readonly test: (id: string) => Effect.Effect<{
      readonly ok: boolean;
      readonly detail: string;
      readonly reachability: "reachable" | "unreachable";
    }, RemoteHostsError>;
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
): HostsServiceShape => {
  return {
    doctor: runRemoteHostsDoctor(registry, ssh),
    doctorSnapshot: runRemoteHostsDoctorSnapshot(
      registry,
      ssh,
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
        return yield* testHostConnection(ssh, host);
      }),

  };
};

const persistenceError = (operation: string, cause: unknown): RemoteHostsError =>
  new RemoteHostsError("io", `hosts database ${operation} failed: ${
    cause instanceof Error ? cause.message : String(cause)
  }`);

/** Owns host registry transactions on the product connection. */
export const HostsPersistenceLive = Layer.effect(HostsPersistence, Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* HostRegistryRows;
  const initialize = Effect.gen(function* () {
    if (yield* rows.initialized.pipe(Effect.mapError((cause) => persistenceError("initialize-read", cause)))) return;
    yield* sql.withTransaction(rows.ensure(new Date().toISOString())).pipe(
      Effect.provideService(StateTransactionOperation, "hosts.initialize"),
      Effect.mapError((cause) => persistenceError("initialize-write", cause)),
    );
  }).pipe(Effect.withSpan("HostsPersistence.initialize"));
  const read = rows.read.pipe(Effect.mapError((cause) => persistenceError("list", cause)));
  const upsert = Effect.fn("HostsPersistence.upsert")(function* (host: RemoteHostT) {
    return yield* sql.withTransaction(rows.upsert(host)).pipe(
      Effect.provideService(StateTransactionOperation, "hosts.upsert"),
      Effect.mapError((cause) => cause instanceof RemoteHostsError ? cause : persistenceError("upsert", cause)),
    );
  });
  const remove = Effect.fn("HostsPersistence.remove")(function* (id: string) {
    return yield* sql.withTransaction(Effect.gen(function* () {
      const current = yield* rows.read;
      if (!current.hosts.some((host) => host.id === id)) {
        return yield* Effect.fail(new RemoteHostsError("not_found", `unknown host: ${id}`));
      }
      yield* rows.delete(id);
      return yield* rows.read;
    })).pipe(
      Effect.provideService(StateTransactionOperation, "hosts.remove"),
      Effect.mapError((cause) => cause instanceof RemoteHostsError ? cause : persistenceError("remove", cause)),
    );
  });
  return { initialize, read, upsert, remove };
})).pipe(Layer.provide(HostRegistryRows.layer));

export const HostsServiceLive = Layer.effect(
  HostsService,
  Effect.gen(function* () {
    const ssh = yield* SshTransport;
    const persistence = yield* HostsPersistence;
    // Capture warm ambient Context so registry Promise bridges never use bare
    // Effect.runPromise (AppRuntime / RemoteRuntime host entry).
    const runtime = yield* Effect.context<never>();
    const runPromise = <A, E>(effect: Effect.Effect<A, E, never>) =>
      Effect.runPromiseWith(runtime)(effect);
    const registry = getDefaultHostsRegistry(persistence, runPromise);
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
    return makeHostsService(registry, ssh);
  }),
).pipe(Layer.provide(HostsPersistenceLive));
