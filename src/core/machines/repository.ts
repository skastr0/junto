import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { InstallationId } from "@shared/installation-id";
import { MachineBuild, MachineBuiltAt, MachineName, MachineVersion } from "@shared/machine-control";
import { defaultMachineName } from "@shared/machine-name";
import { StateTransactionOperation } from "../../node/state/transaction-operation";
import { withSqlRead } from "../state/sql-read";
import type { Log } from "../../node/observability/logger";
import { MachineConfigurationRepository, MachineRefused, type StoredMachineConfiguration } from "./configuration";
import { KnownInstallations } from "./known-installations";

const Timestamp = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64)));
/** A peer's live time moves at most this often while its build stays the same. */
const PEER_LIVE_RESOLUTION_MS = 60_000;
const PeerIdentity = Schema.Struct({ machineName: MachineName, installationId: InstallationId });
export type MachinePeerIdentity = typeof PeerIdentity.Type;
/**
 * `binding: "key"`: the peer links to this machine only through a link key
 * bound to it (docs/machines.md, The link), set by the broker step and
 * changed only by retirement. Absent: the account's own SSH access, as before.
 */
export type MachinePeer = MachinePeerIdentity & { readonly boundAt: string; readonly binding?: "key" };
/**
 * What an active peer last said of itself in a hello this machine admitted:
 * its build, the release and build time it claims, and the last time it was
 * live here. Display, and the take-over's live window.
 */
export type MachinePeerSeen = MachinePeerIdentity & {
  readonly build: string; readonly version?: string; readonly builtAt?: string; readonly seenAt: string;
};

/**
 * What a pin needs to replace a retired one under another installation
 * (remote-security P1 to P6): the old link-key line removed, outside the SQL,
 * and the work this machine still places on the name, counted inside the
 * transaction that replaces the row. A pin without it refuses as before.
 */
export type RetiredPinRule = {
  readonly forget: (machineName: string, installationId: InstallationId) => Effect.Effect<unknown, unknown>;
  readonly placements: (machineName: string) => Effect.Effect<{ readonly seats: number; readonly automations: number; readonly files: number }, unknown>;
};

/** The name was retired, and work here is still placed on it: a take-over moves it, so nothing changed. */
export const RETIRED_PLACED_MESSAGE = (name: string) =>
  `machine ${JSON.stringify(name)} was removed, but seats, automations or Files nodes here are still placed on it; take it over to move them`;

export class MachinePersistenceError extends Schema.TaggedError<MachinePersistenceError>()(
  "MachinePersistenceError", { operation: Schema.String, message: Schema.String, cause: Schema.Unknown },
) {}

export class MachineRepository extends Context.Service<MachineRepository, {
  readonly installationId: Effect.Effect<InstallationId, MachinePersistenceError>;
  readonly machineName: Effect.Effect<string, MachinePersistenceError>;
  readonly configuration: Effect.Effect<StoredMachineConfiguration, MachinePersistenceError>;
  readonly configureName: (name: string) => Effect.Effect<StoredMachineConfiguration, MachinePersistenceError>;
  /** `binding: "key"` marks the peer as linking only through its link key (MachinePeer). */
  readonly pinPeer: (identity: MachinePeerIdentity, options?: { readonly binding?: "key"; readonly retired?: RetiredPinRule }) => Effect.Effect<MachinePeer, MachinePersistenceError>;
  /**
   * In the caller's transaction: the retired row of `machineName`, still
   * retired under `previous`, becomes a plain pin of `installationId`, and
   * the old installation's vault tokens, owed deletes and seen row go. The
   * new pin is plain: no key binding, by construction. The
   * old link-key line must already be gone. False, changing nothing, when the
   * row is no longer retired under `previous`.
   */
  readonly replaceRetiredPin: (input: { readonly machineName: string; readonly previous: InstallationId; readonly installationId: InstallationId }) => Effect.Effect<MachinePeer | undefined, MachinePersistenceError>;
  readonly peer: (machineName: string) => Effect.Effect<MachinePeer | undefined, MachinePersistenceError>;
  /** The installation a retired name was last pinned to, for the take-over line a refusal prints: it decides nothing. */
  readonly retiredPin: (machineName: string) => Effect.Effect<InstallationId | undefined, MachinePersistenceError>;
  readonly peers: Effect.Effect<ReadonlyArray<MachinePeer>, MachinePersistenceError>;
  readonly retirePeer: (machineName: string) => Effect.Effect<void, MachinePersistenceError>;
  /** Names a peer was pinned under and later retired, and not pinned again. */
  readonly retiredPeers: Effect.Effect<ReadonlyArray<string>, MachinePersistenceError>;
  /**
   * Keeps what an admitted hello said, for an active peer under the
   * installation it was pinned to; any other hello writes nothing. A release
   * or build time its schema refuses is left out. The seen time is the
   * peer's last live time: every hello may move it, throttled to one write
   * per minute unless the build changed.
   */
  readonly notePeerHello: (hello: MachinePeerIdentity & { readonly build: string; readonly version?: string; readonly builtAt?: string }) => Effect.Effect<void, MachinePersistenceError>;
  /** What each active peer last said, under the installation it is pinned to. */
  readonly peersSeen: Effect.Effect<ReadonlyArray<MachinePeerSeen>, MachinePersistenceError>;
  /** Retires the live pin of exactly that installation, whatever its name; answers whether one was retired. */
  readonly retirePeerInstallation: (installationId: InstallationId) => Effect.Effect<boolean, MachinePersistenceError>;
}>()("@junto/MachineRepository") {}

const InstallationRow = Schema.Struct({ installation_id: InstallationId, created_at: Timestamp });
const PeerRow = Schema.Struct({
  machine_name: MachineName, installation_id: InstallationId,
  bound_at: Timestamp, retired_at: Schema.NullOr(Timestamp), binding: Schema.NullOr(Schema.Literal("key")),
});
const SeenRow = Schema.Struct({
  machine_name: MachineName, installation_id: InstallationId, build: MachineBuild,
  version: Schema.NullOr(Schema.String), built_at: Schema.NullOr(Schema.String), seen_at: Timestamp,
});
const peerFromRow = (row: typeof PeerRow.Type): MachinePeer => ({
  machineName: row.machine_name, installationId: row.installation_id, boundAt: row.bound_at,
  ...(row.binding === null ? {} : { binding: row.binding }),
});
const failure = (operation: string) => (cause: unknown): MachinePersistenceError =>
  cause instanceof MachinePersistenceError ? cause : MachinePersistenceError.make({
    operation, message: cause instanceof Error ? cause.message : String(cause), cause,
  });

export type MachineRepositoryOptions = {
  readonly makeInstallationId?: () => InstallationId;
  readonly defaultName?: () => string;
  readonly now?: () => string;
  /** The process's log, so its rows name the machine from the write that names it. */
  readonly log?: Log;
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
    if (stored === undefined) return yield* new MachineRefused({ check: "configuration-missing", message: "machine configuration disappeared" });
    return stored;
  })).pipe(Effect.mapError(failure("configuration")));
  const findPeer = SqlSchema.findOneOption({ Request: Schema.String, Result: PeerRow,
    execute: (name) => sql`SELECT machine_name, installation_id, bound_at, retired_at, binding FROM machine_peers WHERE machine_name = ${name}` });
  const peer = Effect.fn("MachineRepository.peer")((name: string) =>
    withSqlRead(sql, findPeer(name)).pipe(Effect.map((row) =>
      Option.isSome(row) && row.value.retired_at === null ? peerFromRow(row.value) : undefined), Effect.mapError(failure("peer"))));
  const retiredPin = Effect.fn("MachineRepository.retiredPin")((name: string) =>
    withSqlRead(sql, findPeer(name)).pipe(Effect.map((row) =>
      Option.isSome(row) && row.value.retired_at !== null ? row.value.installation_id : undefined), Effect.mapError(failure("peer"))));
  const peers = withSqlRead(sql, SqlSchema.findAll({ Request: Schema.Void, Result: PeerRow,
    execute: () => sql`SELECT machine_name, installation_id, bound_at, retired_at, binding FROM machine_peers WHERE retired_at IS NULL ORDER BY machine_name`,
  })(undefined)).pipe(Effect.map((rows) => rows.map(peerFromRow)), Effect.mapError(failure("peers")));
  const replaceRetiredRow = (input: { readonly machineName: string; readonly previous: InstallationId; readonly installationId: InstallationId }) =>
    Effect.gen(function* () {
      const row = yield* findPeer(input.machineName);
      if (Option.isNone(row) || row.value.retired_at === null || row.value.installation_id !== input.previous) return undefined;
      const at = yield* Schema.decodeUnknownEffect(Timestamp)(now());
      // What the old installation held here goes with it; known_installations keeps it.
      yield* sql`DELETE FROM machine_vault_tokens WHERE machine_name = ${input.machineName}`;
      yield* sql`DELETE FROM terminal_delete_owed WHERE machine_name = ${input.machineName}`;
      yield* sql`DELETE FROM machine_peer_seen WHERE installation_id = ${input.previous}`;
      yield* installations.register(input.installationId, at);
      // Replaced in this one transaction, never left without a row (P4): a
      // peer's identity never changes in place (machine_peer_identity_immutable),
      // so the retired row goes and the new pin goes in plain.
      yield* sql`DELETE FROM machine_peers WHERE machine_name = ${input.machineName} AND installation_id = ${input.previous} AND retired_at IS NOT NULL`;
      yield* sql`INSERT INTO machine_peers(machine_name, installation_id, bound_at, retired_at, binding) VALUES (${input.machineName}, ${input.installationId}, ${at}, NULL, NULL)`;
      yield* Effect.logInfo("machine retired pin replaced").pipe(Effect.annotateLogs({
        area: "machines", machine: input.machineName, previousInstallationId: input.previous, installationId: input.installationId }));
      return { machineName: input.machineName, installationId: input.installationId, boundAt: at } satisfies MachinePeer;
    });
  const replaceRetiredPin = Effect.fn("MachineRepository.replaceRetiredPin")((input: { readonly machineName: string; readonly previous: InstallationId; readonly installationId: InstallationId }) =>
    sql.withTransaction(replaceRetiredRow(input)).pipe(Effect.provideService(StateTransactionOperation, "machine.replace-retired-pin")),
  Effect.mapError(failure("replace-retired-pin")));
  const pinPeer = Effect.fn("MachineRepository.pinPeer")(function* (input: MachinePeerIdentity, pinOptions?: { readonly binding?: "key"; readonly retired?: RetiredPinRule }) {
    const identity = yield* Schema.decodeUnknownEffect(PeerIdentity)(input, { onExcessProperty: "error" });
    const binding = pinOptions?.binding === "key" ? "key" as const : undefined;
    const rule = pinOptions?.retired;
    // A retired row under another installation is replaced only with the rule,
    // and its old link-key line goes first, outside the SQL (P3).
    const before = rule === undefined ? Option.none() : yield* withSqlRead(sql, findPeer(identity.machineName));
    const retired = Option.isSome(before) && before.value.retired_at !== null && before.value.installation_id !== identity.installationId
      ? before.value.installation_id : undefined;
    if (rule !== undefined && retired !== undefined) {
      // Work still placed on the name refuses before anything changes, the line included (P2);
      // the transaction counts again, so a placement made meanwhile still refuses.
      const placed = yield* rule.placements(identity.machineName);
      if (placed.seats + placed.automations + placed.files > 0)
        return yield* new MachineRefused({ check: "name-retired-placed", machine: identity.machineName, message: RETIRED_PLACED_MESSAGE(identity.machineName) });
      yield* rule.forget(identity.machineName, retired).pipe(Effect.mapError(() => new MachineRefused({ check: "retired-line-kept", machine: identity.machineName,
        message: `the old link key of machine ${JSON.stringify(identity.machineName)} could not be removed; nothing was changed` })));
    }
    return yield* sql.withTransaction(Effect.gen(function* () {
      const own = yield* configurations.read;
      if (identity.installationId === installationId || identity.machineName === own?.configuration.name)
        return yield* new MachineRefused({ check: "peer-is-self", machine: identity.machineName, message: "a peer must be another installation with another machine name" });
      const existing = yield* findPeer(identity.machineName);
      if (Option.isSome(existing)) {
        if (existing.value.installation_id !== identity.installationId) {
          // A live pin under another installation always refuses (P1).
          if (rule === undefined || retired === undefined || existing.value.retired_at === null)
            return yield* new MachineRefused({ check: "name-pinned-elsewhere", machine: identity.machineName,
              message: `machine ${JSON.stringify(identity.machineName)} is pinned to another installation; choose another name` });
          // CAS on the row read before the line was removed (P1).
          if (existing.value.installation_id !== retired)
            return yield* new MachineRefused({ check: "retired-pin-changed", machine: identity.machineName,
              message: `the pin of machine ${JSON.stringify(identity.machineName)} changed during setup; nothing was changed` });
          const sameInstallation = yield* sql`SELECT machine_name FROM machine_peers WHERE installation_id = ${identity.installationId}`;
          if (sameInstallation.length) return yield* new MachineRefused({ check: "installation-pinned-elsewhere", machine: identity.machineName, message: "the peer installation is pinned to another machine name" });
          // Work still placed on the name is the operator's to move with a take-over (P2).
          const placed = yield* rule.placements(identity.machineName);
          if (placed.seats + placed.automations + placed.files > 0)
            return yield* new MachineRefused({ check: "name-retired-placed", machine: identity.machineName, message: RETIRED_PLACED_MESSAGE(identity.machineName) });
          const replaced = yield* replaceRetiredRow({ machineName: identity.machineName, previous: retired, installationId: identity.installationId });
          if (replaced === undefined)
            return yield* new MachineRefused({ check: "retired-pin-changed", machine: identity.machineName,
              message: `the pin of machine ${JSON.stringify(identity.machineName)} changed during setup; nothing was changed` });
          return replaced;
        }
        // A retired peer came back with no binding; a key binding, once set, is never dropped by a pin.
        const kept = existing.value.retired_at === null ? existing.value.binding : null;
        const next = binding ?? kept;
        if (existing.value.retired_at !== null || next !== existing.value.binding)
          yield* sql`UPDATE machine_peers SET retired_at = NULL, binding = ${next} WHERE machine_name = ${identity.machineName}`;
        return peerFromRow({ ...existing.value, retired_at: null, binding: next });
      }
      const sameInstallation = yield* sql`SELECT machine_name FROM machine_peers WHERE installation_id = ${identity.installationId}`;
      if (sameInstallation.length) return yield* new MachineRefused({ check: "installation-pinned-elsewhere", machine: identity.machineName, message: "the peer installation is pinned to another machine name" });
      const at = yield* Schema.decodeUnknownEffect(Timestamp)(now());
      yield* installations.register(identity.installationId, at);
      yield* sql`INSERT INTO machine_peers(machine_name, installation_id, bound_at, binding) VALUES (${identity.machineName}, ${identity.installationId}, ${at}, ${binding ?? null})`;
      return { ...identity, boundAt: at, ...(binding === undefined ? {} : { binding }) };
    })).pipe(Effect.provideService(StateTransactionOperation, "machine.pin-peer"));
  }, Effect.mapError(failure("pin-peer")));
  const retirePeer = Effect.fn("MachineRepository.retirePeer")((name: string) =>
    sql.withTransaction(Effect.gen(function* () {
      // What a retired peer said is no longer its word: it is heard again when it is pinned again and links.
      yield* sql`DELETE FROM machine_peer_seen WHERE installation_id IN
        (SELECT installation_id FROM machine_peers WHERE machine_name = ${name} AND retired_at IS NULL)`;
      yield* sql`UPDATE machine_peers SET retired_at = ${now()}, binding = NULL WHERE machine_name = ${name} AND retired_at IS NULL`;
    })).pipe(
      Effect.asVoid, Effect.provideService(StateTransactionOperation, "machine.retire-peer"), Effect.mapError(failure("retire-peer")),
    ));
  const retiredPeers = withSqlRead(sql, SqlSchema.findAll({ Request: Schema.Void, Result: Schema.Struct({ machine_name: MachineName }),
    execute: () => sql`SELECT machine_name FROM machine_peers WHERE retired_at IS NOT NULL ORDER BY machine_name`,
  })(undefined)).pipe(Effect.map((rows) => rows.map((row) => row.machine_name)), Effect.mapError(failure("retired-peers")));
  const notePeerHello = Effect.fn("MachineRepository.notePeerHello")(function* (hello: MachinePeerIdentity & { readonly build: string; readonly version?: string; readonly builtAt?: string }) {
    const identity = yield* Schema.decodeUnknownEffect(PeerIdentity)({ machineName: hello.machineName, installationId: hello.installationId });
    const build = yield* Schema.decodeUnknownEffect(MachineBuild)(hello.build);
    const version = hello.version !== undefined && Schema.is(MachineVersion)(hello.version) ? hello.version : null;
    const builtAt = hello.builtAt !== undefined && Schema.is(MachineBuiltAt)(hello.builtAt) ? hello.builtAt : null;
    const at = yield* Schema.decodeUnknownEffect(Timestamp)(now());
    // A live time moves at most once a minute unless the build changed: an
    // unchanged build inside that minute leaves the row and its time alone.
    const cutoff = new Date(Date.parse(at) - PEER_LIVE_RESOLUTION_MS).toISOString();
    yield* sql.withTransaction(sql`
      INSERT INTO machine_peer_seen(installation_id, build, version, built_at, seen_at)
      SELECT ${identity.installationId}, ${build}, ${version}, ${builtAt}, ${at}
      WHERE EXISTS (SELECT 1 FROM machine_peers WHERE machine_name = ${identity.machineName}
        AND installation_id = ${identity.installationId} AND retired_at IS NULL)
      ON CONFLICT(installation_id) DO UPDATE SET build = excluded.build,
        version = excluded.version, built_at = excluded.built_at, seen_at = excluded.seen_at
      WHERE machine_peer_seen.build <> excluded.build OR machine_peer_seen.seen_at <= ${cutoff}`).pipe(
      Effect.provideService(StateTransactionOperation, "machine.note-peer-hello"));
  }, Effect.asVoid, Effect.mapError(failure("note-peer-hello")));
  const peersSeen = withSqlRead(sql, SqlSchema.findAll({ Request: Schema.Void, Result: SeenRow,
    execute: () => sql`SELECT p.machine_name, s.installation_id, s.build, s.version, s.built_at, s.seen_at
      FROM machine_peer_seen s JOIN machine_peers p ON p.installation_id = s.installation_id
      WHERE p.retired_at IS NULL ORDER BY p.machine_name`,
  })(undefined)).pipe(Effect.map((rows) => rows.map((row): MachinePeerSeen => ({
    machineName: row.machine_name, installationId: row.installation_id, build: row.build, seenAt: row.seen_at,
    ...(row.version === null ? {} : { version: row.version }), ...(row.built_at === null ? {} : { builtAt: row.built_at }),
  }))), Effect.mapError(failure("peers-seen")));
  const retirePeerInstallation = Effect.fn("MachineRepository.retirePeerInstallation")((installationId: InstallationId) =>
    sql.withTransaction(Effect.gen(function* () {
      const live = yield* sql`SELECT machine_name FROM machine_peers WHERE installation_id = ${installationId} AND retired_at IS NULL`;
      if (live.length === 0) return false;
      yield* sql`DELETE FROM machine_peer_seen WHERE installation_id = ${installationId}`;
      yield* sql`UPDATE machine_peers SET retired_at = ${now()}, binding = NULL WHERE installation_id = ${installationId} AND retired_at IS NULL`;
      return true;
    })).pipe(Effect.provideService(StateTransactionOperation, "machine.retire-peer"), Effect.mapError(failure("retire-peer"))));
  const configureName = Effect.fn("MachineRepository.configureName")(function* (input: string) {
    const name = yield* Schema.decodeUnknownEffect(MachineName)(input);
    return yield* sql.withTransaction(Effect.gen(function* () {
      const stored = yield* configurations.read;
      if (stored === undefined) return yield* new MachineRefused({ check: "configuration-missing", message: "machine configuration disappeared" });
      const previous = stored.configuration.name;
      if (name === previous) return stored;
      const pins = yield* sql`SELECT 1 FROM machine_peers LIMIT 1`;
      if (pins.length) return yield* new MachineRefused({ check: "name-fixed-by-peer", machine: previous, message: "This machine's name is fixed because a peer has been pinned, including a retired peer." });
      const authored = yield* sql`SELECT 1 FROM canvases WHERE seq > 0 LIMIT 1`;
      if (authored.length) return yield* new MachineRefused({ check: "name-fixed-by-canvas", machine: previous, message: "This machine's name is fixed because a canvas has been authored or received." });
      const configuredAt = yield* Schema.decodeUnknownEffect(Timestamp)(now());
      const configuration = { ...stored.configuration, name };
      yield* configurations.write(configuration, configuredAt);
      yield* sql`UPDATE host_registry SET id = ${name} WHERE is_this_machine = 1 AND id = ${previous}`;
      return { configuration, configuredAt };
    })).pipe(Effect.provideService(StateTransactionOperation, "machine.configure-name"),
      // Log rows name the machine from the moment its name is written, not from the next start.
      Effect.tap((stored) => Effect.sync(() => options.log?.setMachine(stored.configuration.name))));
  }, Effect.mapError(failure("configure-name")));
  return MachineRepository.of({ installationId: Effect.succeed(installationId), configuration,
    machineName: configuration.pipe(Effect.map((stored) => stored.configuration.name)), configureName, pinPeer, peer, retiredPin, peers, retirePeer,
    retiredPeers, notePeerHello, peersSeen, retirePeerInstallation, replaceRetiredPin });
});

export const makeMachineRepositoryLive = (options: MachineRepositoryOptions = {}) =>
  Layer.effect(MachineRepository, makeMachineRepository(options)).pipe(
    Layer.provide([MachineConfigurationRepository.layer, KnownInstallations.layer]),
  );
export const MachineRepositoryLive = makeMachineRepositoryLive();
