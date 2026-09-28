import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import type { CompanionDeviceRecord } from "@shared/companion-devices";
import { StateTransactionOperation } from "../state/service";

export class CompanionDevicePersistenceError extends Schema.TaggedError<CompanionDevicePersistenceError>()(
  "CompanionDevicePersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** A device row with its key, for main only (the key goes to authorized_keys). */
export type CompanionDeviceRow = CompanionDeviceRecord & { readonly publicKey: string };

export type CompletePairingResult =
  | { readonly ok: true; readonly device: CompanionDeviceRow; readonly pairingKey: string }
  | { readonly ok: false; readonly reason: "unknown" | "already-paired" | "expired" };

/** Last-seen is a glance fact; it is written at most this often per device. */
export const COMPANION_LAST_SEEN_RESOLUTION_MS = 60_000;

/**
 * The paired-device registry (`companion_devices`): the durable answer to
 * "may this phone speak to this Mac". companion-stdio's device id is checked
 * here on every relayed call; Remove deletes the row.
 */
export class CompanionDeviceRepository extends Context.Service<CompanionDeviceRepository,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<CompanionDeviceRow>, CompanionDevicePersistenceError>;
    readonly get: (deviceId: string) => Effect.Effect<CompanionDeviceRow | undefined, CompanionDevicePersistenceError>;
    /** A new device waiting for its phone; the key is the one-time pairing key. */
    readonly createPairing: (input: {
      readonly deviceId: string;
      readonly pairingPublicKey: string;
      readonly expiresAt: number;
      readonly now: number;
    }) => Effect.Effect<CompanionDeviceRow, CompanionDevicePersistenceError>;
    /** Swap the pairing key for the phone's own and mark the device paired. */
    readonly completePairing: (input: {
      readonly deviceId: string;
      readonly publicKey: string;
      readonly name: string;
      readonly now: number;
    }) => Effect.Effect<CompletePairingResult, CompanionDevicePersistenceError>;
    /** Record contact; a write only when the stored time is older than the resolution. */
    readonly touch: (deviceId: string, now: number) => Effect.Effect<void, CompanionDevicePersistenceError>;
    readonly remove: (deviceId: string) => Effect.Effect<CompanionDeviceRow | undefined, CompanionDevicePersistenceError>;
    /** Delete every pairing device whose QR expired unused; returns them. */
    readonly removeExpired: (now: number) => Effect.Effect<ReadonlyArray<CompanionDeviceRow>, CompanionDevicePersistenceError>;
  }>()("@junto/CompanionDeviceRepository") {}

const DeviceRow = Schema.Struct({
  device_id: Schema.String,
  name: Schema.String,
  state: Schema.Literals(["paired", "pairing"]),
  public_key: Schema.String,
  pairing_expires_at: Schema.NullOr(Schema.Number),
  created_at: Schema.Number,
  paired_at: Schema.NullOr(Schema.Number),
  last_seen_at: Schema.NullOr(Schema.Number),
});

const COLUMNS =
  "device_id, name, state, public_key, pairing_expires_at, created_at, paired_at, last_seen_at";

const fromRow = (row: typeof DeviceRow.Type): CompanionDeviceRow => ({
  deviceId: row.device_id,
  name: row.name,
  state: row.state === "paired" ? "paired" : "pairing",
  publicKey: row.public_key,
  createdAt: row.created_at,
  ...(row.paired_at !== null ? { pairedAt: row.paired_at } : {}),
  ...(row.last_seen_at !== null ? { lastSeenAt: row.last_seen_at } : {}),
  ...(row.pairing_expires_at !== null ? { pairingExpiresAt: row.pairing_expires_at } : {}),
});

const persistence = (operation: string) => (error: SqlError.SqlError | Schema.SchemaError) =>
  CompanionDevicePersistenceError.make({ operation, message: error.message, cause: error });

export const CompanionDeviceRepositoryLive: Layer.Layer<CompanionDeviceRepository, never, SqlClient.SqlClient> = Layer.effect(
  CompanionDeviceRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const oneRow = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: DeviceRow,
      execute: (deviceId) => sql.unsafe(`SELECT ${COLUMNS} FROM companion_devices WHERE device_id = ?`, [deviceId]),
    });
    const readRow = Effect.fn("companion-devices.read-row")(function* (deviceId: string) {
      const row = yield* oneRow(deviceId);
      return row._tag === "None" ? undefined : row.value;
    });
    const allRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: DeviceRow,
      execute: () => sql.unsafe(`SELECT ${COLUMNS} FROM companion_devices ORDER BY created_at, device_id`),
    });
    const expiredRows = SqlSchema.findAll({
      Request: Schema.Number,
      Result: DeviceRow,
      execute: (now) => sql.unsafe(`SELECT ${COLUMNS} FROM companion_devices WHERE state = 'pairing' AND pairing_expires_at <= ?`, [now]),
    });

    const list = Effect.fn("companion-devices.list")(function* () {
      return (yield* allRows(undefined)).map(fromRow);
    }, Effect.mapError(persistence("list")));

    const get = Effect.fn("companion-devices.get")(function* (deviceId: string) {
      const row = yield* readRow(deviceId);
      return row === undefined ? undefined : fromRow(row);
    }, Effect.mapError(persistence("get")));

    const createPairing = Effect.fn("companion-devices.create-pairing")(function* (input: {
      readonly deviceId: string;
      readonly pairingPublicKey: string;
      readonly expiresAt: number;
      readonly now: number;
    }) {
      yield* sql`
        INSERT INTO companion_devices(device_id, name, state, public_key, pairing_expires_at, created_at)
        VALUES (${input.deviceId}, '', 'pairing', ${input.pairingPublicKey}, ${input.expiresAt}, ${input.now})
      `;
      return fromRow((yield* readRow(input.deviceId))!);
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "companion-devices.create-pairing"),
    Effect.mapError(persistence("create-pairing")));

    const completePairing = Effect.fn("companion-devices.complete-pairing")(function* (input: {
      readonly deviceId: string;
      readonly publicKey: string;
      readonly name: string;
      readonly now: number;
    }) {
      const row = yield* readRow(input.deviceId);
      if (row === undefined) return { ok: false, reason: "unknown" } as const;
      if (row.state === "paired") return { ok: false, reason: "already-paired" } as const;
      if (row.pairing_expires_at !== null && row.pairing_expires_at <= input.now) {
        return { ok: false, reason: "expired" } as const;
      }
      yield* sql`
        UPDATE companion_devices
        SET name = ${input.name}, state = 'paired', public_key = ${input.publicKey}, pairing_expires_at = NULL,
            paired_at = ${input.now}, last_seen_at = ${input.now}
        WHERE device_id = ${input.deviceId}
      `;
      return { ok: true, device: fromRow((yield* readRow(input.deviceId))!), pairingKey: row.public_key } as const;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "companion-devices.complete-pairing"),
    Effect.mapError(persistence("complete-pairing")));

    const touch = Effect.fn("companion-devices.touch")(function* (deviceId: string, now: number) {
      yield* sql`
        UPDATE companion_devices SET last_seen_at = ${now}
        WHERE device_id = ${deviceId} AND state = 'paired'
          AND (last_seen_at IS NULL OR last_seen_at <= ${now - COMPANION_LAST_SEEN_RESOLUTION_MS})
      `;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "companion-devices.touch"),
    Effect.mapError(persistence("touch")));

    const remove = Effect.fn("companion-devices.remove")(function* (deviceId: string) {
      const row = yield* readRow(deviceId);
      if (row === undefined) return undefined;
      yield* sql`DELETE FROM companion_devices WHERE device_id = ${deviceId}`;
      return fromRow(row);
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "companion-devices.remove"),
    Effect.mapError(persistence("remove")));

    const removeExpired = Effect.fn("companion-devices.remove-expired")(function* (now: number) {
      const rows = yield* expiredRows(now);
      for (const row of rows) yield* sql`DELETE FROM companion_devices WHERE device_id = ${row.device_id}`;
      return rows.map(fromRow);
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "companion-devices.remove-expired"),
    Effect.mapError(persistence("remove-expired")));

    return { list, get, createPairing, completePairing, touch, remove, removeExpired };
  }),
);
