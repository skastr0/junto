import { Context, Effect, Layer, Schema } from "effect";
import type { CompanionDeviceRecord } from "@shared/companion-devices";
import { StateEngine, type StateEngineError, type StateRow } from "../state/service";

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

type DeviceRow = StateRow & {
  readonly device_id: string;
  readonly name: string;
  readonly state: string;
  readonly public_key: string;
  readonly pairing_expires_at: number | null;
  readonly created_at: number;
  readonly paired_at: number | null;
  readonly last_seen_at: number | null;
};

const COLUMNS =
  "device_id, name, state, public_key, pairing_expires_at, created_at, paired_at, last_seen_at";

const fromRow = (row: DeviceRow): CompanionDeviceRow => ({
  deviceId: row.device_id,
  name: row.name,
  state: row.state === "paired" ? "paired" : "pairing",
  publicKey: row.public_key,
  createdAt: row.created_at,
  ...(row.paired_at !== null ? { pairedAt: row.paired_at } : {}),
  ...(row.last_seen_at !== null ? { lastSeenAt: row.last_seen_at } : {}),
  ...(row.pairing_expires_at !== null ? { pairingExpiresAt: row.pairing_expires_at } : {}),
});

const persistence = (operation: string) => (error: StateEngineError) =>
  CompanionDevicePersistenceError.make({ operation, message: error.message, cause: error });

export const CompanionDeviceRepositoryLive: Layer.Layer<CompanionDeviceRepository, never, StateEngine> = Layer.effect(
  CompanionDeviceRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;

    const list = () =>
      state
        .read("companion-devices.list", (reader) =>
          reader.all<DeviceRow>(`SELECT ${COLUMNS} FROM companion_devices ORDER BY created_at, device_id`).map(fromRow),
        )
        .pipe(Effect.mapError(persistence("list")));

    const get = (deviceId: string) =>
      state
        .read("companion-devices.get", (reader) => {
          const row = reader.get<DeviceRow>(`SELECT ${COLUMNS} FROM companion_devices WHERE device_id = ?`, [deviceId]);
          return row === undefined ? undefined : fromRow(row);
        })
        .pipe(Effect.mapError(persistence("get")));

    const createPairing = (input: {
      readonly deviceId: string;
      readonly pairingPublicKey: string;
      readonly expiresAt: number;
      readonly now: number;
    }) =>
      state
        .transaction("companion-devices.create-pairing", (writer) => {
          writer.run(
            `INSERT INTO companion_devices(device_id, name, state, public_key, pairing_expires_at, created_at)
             VALUES (?, '', 'pairing', ?, ?, ?)`,
            [input.deviceId, input.pairingPublicKey, input.expiresAt, input.now],
          );
          return fromRow(
            writer.get<DeviceRow>(`SELECT ${COLUMNS} FROM companion_devices WHERE device_id = ?`, [input.deviceId])!,
          );
        })
        .pipe(Effect.mapError(persistence("create-pairing")));

    const completePairing = (input: {
      readonly deviceId: string;
      readonly publicKey: string;
      readonly name: string;
      readonly now: number;
    }) =>
      state
        .transaction("companion-devices.complete-pairing", (writer): CompletePairingResult => {
          const row = writer.get<DeviceRow>(`SELECT ${COLUMNS} FROM companion_devices WHERE device_id = ?`, [
            input.deviceId,
          ]);
          if (row === undefined) return { ok: false, reason: "unknown" };
          if (row.state === "paired") return { ok: false, reason: "already-paired" };
          if (row.pairing_expires_at !== null && row.pairing_expires_at <= input.now) {
            return { ok: false, reason: "expired" };
          }
          writer.run(
            `UPDATE companion_devices
               SET name = ?, state = 'paired', public_key = ?, pairing_expires_at = NULL,
                   paired_at = ?, last_seen_at = ?
             WHERE device_id = ?`,
            [input.name, input.publicKey, input.now, input.now, input.deviceId],
          );
          const next = writer.get<DeviceRow>(`SELECT ${COLUMNS} FROM companion_devices WHERE device_id = ?`, [
            input.deviceId,
          ])!;
          return { ok: true, device: fromRow(next), pairingKey: row.public_key };
        })
        .pipe(Effect.mapError(persistence("complete-pairing")));

    const touch = (deviceId: string, now: number) =>
      state
        .transaction("companion-devices.touch", (writer) => {
          writer.run(
            `UPDATE companion_devices SET last_seen_at = ?
             WHERE device_id = ? AND state = 'paired'
               AND (last_seen_at IS NULL OR last_seen_at <= ?)`,
            [now, deviceId, now - COMPANION_LAST_SEEN_RESOLUTION_MS],
          );
        })
        .pipe(Effect.mapError(persistence("touch")));

    const remove = (deviceId: string) =>
      state
        .transaction("companion-devices.remove", (writer) => {
          const row = writer.get<DeviceRow>(`SELECT ${COLUMNS} FROM companion_devices WHERE device_id = ?`, [deviceId]);
          if (row === undefined) return undefined;
          writer.run("DELETE FROM companion_devices WHERE device_id = ?", [deviceId]);
          return fromRow(row);
        })
        .pipe(Effect.mapError(persistence("remove")));

    const removeExpired = (now: number) =>
      state
        .transaction("companion-devices.remove-expired", (writer) => {
          const rows = writer.all<DeviceRow>(
            `SELECT ${COLUMNS} FROM companion_devices WHERE state = 'pairing' AND pairing_expires_at <= ?`,
            [now],
          );
          for (const row of rows) writer.run("DELETE FROM companion_devices WHERE device_id = ?", [row.device_id]);
          return rows.map(fromRow);
        })
        .pipe(Effect.mapError(persistence("remove-expired")));

    return { list, get, createPairing, completePairing, touch, remove, removeExpired };
  }),
);
