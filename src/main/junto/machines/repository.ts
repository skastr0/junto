import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { InstallationId } from "@shared/installation-id";
import { MachineName } from "@shared/machine-control";
import { defaultMachineName } from "@shared/machine-name";
import { StateTransactionOperation } from "../state/service";
import { withSqlRead } from "../state/sql-read";
import { MachineConfigurationRepository, type StoredMachineConfiguration } from "./configuration";
import { KnownInstallations } from "./known-installations";

const Timestamp = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64)));
const PeerIdentity = Schema.Struct({ machineName: MachineName, installationId: InstallationId });
export type MachinePeerIdentity = typeof PeerIdentity.Type;
export type MachinePeer = MachinePeerIdentity & { readonly boundAt: string };

export class MachinePersistenceError extends Schema.TaggedError<MachinePersistenceError>()(
  "MachinePersistenceError", { operation: Schema.String, message: Schema.String, cause: Schema.Unknown },
) {}

export class MachineRepository extends Context.Service<MachineRepository, {
  readonly installationId: Effect.Effect<InstallationId, MachinePersistenceError>;
  readonly machineName: Effect.Effect<string, MachinePersistenceError>;
  readonly configuration: Effect.Effect<StoredMachineConfiguration, MachinePersistenceError>;
  readonly configureName: (name: string) => Effect.Effect<StoredMachineConfiguration, MachinePersistenceError>;
  readonly pinPeer: (identity: MachinePeerIdentity) => Effect.Effect<MachinePeer, MachinePersistenceError>;
  readonly peer: (machineName: string) => Effect.Effect<MachinePeer | undefined, MachinePersistenceError>;
  readonly peers: Effect.Effect<ReadonlyArray<MachinePeer>, MachinePersistenceError>;
  readonly retirePeer: (machineName: string) => Effect.Effect<void, MachinePersistenceError>;
}>()("@junto/MachineRepository") {}

const InstallationRow = Schema.Struct({ installation_id: InstallationId, created_at: Timestamp });
const PeerRow = Schema.Struct({
  machine_name: MachineName, installation_id: InstallationId,
  bound_at: Timestamp, retired_at: Schema.NullOr(Timestamp),
});
const peerFromRow = (row: typeof PeerRow.Type): MachinePeer => ({
  machineName: row.machine_name, installationId: row.installation_id, boundAt: row.bound_at,
});
const failure = (operation: string) => (cause: unknown): MachinePersistenceError =>
  cause instanceof MachinePersistenceError ? cause : MachinePersistenceError.make({
    operation, message: cause instanceof Error ? cause.message : String(cause), cause,
  });

export type MachineRepositoryOptions = {
  readonly makeInstallationId?: () => InstallationId;
  readonly defaultName?: () => string;
  readonly now?: () => string;
};

export const makeMachineRepository = (options: MachineRepositoryOptions = {}) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const configurations = yield* MachineConfigurationRepository;
  const installations = yield* KnownInstallations;
  const now = options.now ?? (() => new Date().toISOString());
  const findInstallation = SqlSchema.findOneOption({ Request: Schema.Void, Result: InstallationRow,
    execute: () => sql`SELECT installation_id, created_at FROM installation WHERE singleton = 1` });
  const installationId = yield* sql.withTransaction(Effect.gen(function* () {
    const existing = yield* findInstallation(undefined);
    if (Option.isSome(existing)) return existing.value.installation_id;
    const id = yield* Schema.decodeUnknownEffect(InstallationId)((options.makeInstallationId ?? randomUUID)());
    const at = yield* Schema.decodeUnknownEffect(Timestamp)(now());
    yield* installations.register(id, at);
    yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${id}, ${at})`;
    return id;
  })).pipe(Effect.provideService(StateTransactionOperation, "machine.ensure-installation"), Effect.mapError(failure("ensure-installation")));
  yield* sql.withTransaction(Effect.gen(function* () {
    if ((yield* configurations.read) !== undefined) return;
    const name = yield* Schema.decodeUnknownEffect(MachineName)((options.defaultName ?? defaultMachineName)());
    yield* configurations.write({ name, supervisedPreferred: false }, now());
  })).pipe(Effect.provideService(StateTransactionOperation, "machine.ensure-configuration"), Effect.mapError(failure("ensure-configuration")));
  const configuration = withSqlRead(sql, Effect.gen(function* () {
    const stored = yield* configurations.read;
    if (stored === undefined) return yield* Effect.fail(new Error("machine configuration disappeared"));
    return stored;
  })).pipe(Effect.mapError(failure("configuration")));
  const findPeer = SqlSchema.findOneOption({ Request: Schema.String, Result: PeerRow,
    execute: (name) => sql`SELECT machine_name, installation_id, bound_at, retired_at FROM machine_peers WHERE machine_name = ${name}` });
  const peer = Effect.fn("MachineRepository.peer")((name: string) =>
    withSqlRead(sql, findPeer(name)).pipe(Effect.map((row) =>
      Option.isSome(row) && row.value.retired_at === null ? peerFromRow(row.value) : undefined), Effect.mapError(failure("peer"))));
  const peers = withSqlRead(sql, SqlSchema.findAll({ Request: Schema.Void, Result: PeerRow,
    execute: () => sql`SELECT machine_name, installation_id, bound_at, retired_at FROM machine_peers WHERE retired_at IS NULL ORDER BY machine_name`,
  })(undefined)).pipe(Effect.map((rows) => rows.map(peerFromRow)), Effect.mapError(failure("peers")));
  const pinPeer = Effect.fn("MachineRepository.pinPeer")(function* (input: MachinePeerIdentity) {
    const identity = yield* Schema.decodeUnknownEffect(PeerIdentity)(input, { onExcessProperty: "error" });
    return yield* sql.withTransaction(Effect.gen(function* () {
      const own = yield* configurations.read;
      if (identity.installationId === installationId || identity.machineName === own?.configuration.name)
        return yield* Effect.fail(new Error("a peer must be another installation with another machine name"));
      const existing = yield* findPeer(identity.machineName);
      if (Option.isSome(existing)) {
        if (existing.value.installation_id !== identity.installationId)
          return yield* Effect.fail(new Error(`machine ${JSON.stringify(identity.machineName)} is pinned to another installation; choose another name`));
        if (existing.value.retired_at !== null)
          yield* sql`UPDATE machine_peers SET retired_at = NULL WHERE machine_name = ${identity.machineName}`;
        return peerFromRow(existing.value);
      }
      const sameInstallation = yield* sql`SELECT machine_name FROM machine_peers WHERE installation_id = ${identity.installationId}`;
      if (sameInstallation.length) return yield* Effect.fail(new Error("the peer installation is pinned to another machine name"));
      const at = yield* Schema.decodeUnknownEffect(Timestamp)(now());
      yield* installations.register(identity.installationId, at);
      yield* sql`INSERT INTO machine_peers(machine_name, installation_id, bound_at) VALUES (${identity.machineName}, ${identity.installationId}, ${at})`;
      return { ...identity, boundAt: at };
    })).pipe(Effect.provideService(StateTransactionOperation, "machine.pin-peer"));
  }, Effect.mapError(failure("pin-peer")));
  const retirePeer = Effect.fn("MachineRepository.retirePeer")((name: string) =>
    sql.withTransaction(sql`UPDATE machine_peers SET retired_at = ${now()} WHERE machine_name = ${name} AND retired_at IS NULL`).pipe(
      Effect.asVoid, Effect.provideService(StateTransactionOperation, "machine.retire-peer"), Effect.mapError(failure("retire-peer")),
    ));
  const configureName = Effect.fn("MachineRepository.configureName")(function* (input: string) {
    const name = yield* Schema.decodeUnknownEffect(MachineName)(input);
    return yield* sql.withTransaction(Effect.gen(function* () {
      const stored = yield* configurations.read;
      if (stored === undefined) return yield* Effect.fail(new Error("machine configuration disappeared"));
      const previous = stored.configuration.name;
      if (name === previous) return stored;
      const pins = yield* sql`SELECT 1 FROM machine_peers LIMIT 1`;
      if (pins.length) return yield* Effect.fail(new Error("This machine's name is fixed because a peer has been pinned, including a retired peer."));
      const references = yield* sql`
        SELECT 1 FROM seats WHERE host IN (${previous}, ${name})
        UNION ALL SELECT 1 FROM peers WHERE host IN (${previous}, ${name})
        UNION ALL SELECT 1 FROM terminals WHERE host IN (${previous}, ${name})
        UNION ALL SELECT 1 FROM pages WHERE host IN (${previous}, ${name})
        UNION ALL SELECT 1 FROM crons WHERE host IN (${previous}, ${name})
        UNION ALL SELECT 1 FROM relays WHERE host IN (${previous}, ${name})
        UNION ALL SELECT 1 FROM watchers WHERE host IN (${previous}, ${name})
        UNION ALL SELECT 1 FROM regions WHERE page_host IN (${previous}, ${name})
        LIMIT 1`;
      if (references.length) return yield* Effect.fail(new Error("This machine's name is fixed because a stored row uses it."));
      const configuredAt = yield* Schema.decodeUnknownEffect(Timestamp)(now());
      const configuration = { ...stored.configuration, name };
      yield* configurations.write(configuration, configuredAt);
      yield* sql`UPDATE host_registry SET id = ${name}, effective_hermes_id = coalesce(hermes_id, ${name})
        WHERE is_this_machine = 1 AND id = ${previous}`;
      return { configuration, configuredAt };
    })).pipe(Effect.provideService(StateTransactionOperation, "machine.configure-name"));
  }, Effect.mapError(failure("configure-name")));
  return MachineRepository.of({ installationId: Effect.succeed(installationId), configuration,
    machineName: configuration.pipe(Effect.map((stored) => stored.configuration.name)), configureName, pinPeer, peer, peers, retirePeer });
});

export const makeMachineRepositoryLive = (options: MachineRepositoryOptions = {}) =>
  Layer.effect(MachineRepository, makeMachineRepository(options)).pipe(
    Layer.provide([MachineConfigurationRepository.layer, KnownInstallations.layer]),
  );
export const MachineRepositoryLive = makeMachineRepositoryLive();
