/**
 * The phone companion in the running app.
 *
 * - `dispatch` answers the three `companion.*` operator ops that
 *   `junto companion-stdio` relays: hello, call and events. Every one checks
 *   the device against the paired-device registry first; an unknown or
 *   expired device is `revoked`, a pairing one may only complete pairing.
 * - Pairing (Settings, Companion): a device record, a one-time ed25519 key
 *   installed in authorized_keys with the companion forced command, and a QR
 *   carrying everything the phone needs. It expires after ten minutes and is
 *   swept, key line included. Completing it swaps in the phone's own key.
 * - Remove deletes the authorized_keys line and the record.
 *
 * authorized_keys is edited only through `authorized-keys.ts`, which touches
 * nothing but `junto-companion:` lines.
 */

import { Effect, Result, Schema } from "effect";
import QRCode from "qrcode";
import { ulid } from "ulid";
import {
  handleCompanionRequest,
  makeWriteLimiter,
  outcomeFail,
  outcomeOk,
  type CompanionBackend,
} from "@shared/companion-core";
import type { CompanionDeviceRecord } from "@shared/companion-devices";
import {
  COMPANION_PAIRING_TTL_MS,
  COMPANION_PROTOCOL,
  COMPANION_ERROR_COPY,
  CompanionPublicKey,
  companionError,
  companionFail,
  companionPairingUrl,
  type CompanionRequestFrame,
} from "@shared/companion-protocol";
import {
  OPERATOR_PROTOCOL_VERSION,
  type OperatorRequestEnvelope,
  type OperatorResponseEnvelope,
} from "@shared/operator-control";
import { AppRuntime } from "../../runtime";
import {
  companionKeyLine,
  defaultAuthorizedKeysPath,
  editAuthorizedKeys,
  pruneCompanionKeys,
  removeCompanionKey,
  upsertCompanionKey,
} from "./authorized-keys";
import { makeMainCompanionBackend } from "./backend";
import { makeCompanionChanges, type CompanionChanges } from "./changes";
import { readCompanionEnvironment, type CompanionEnvironment } from "./environment";
import { generatePairingKey } from "./pairing-key";
import { CompanionDeviceRepository, type CompanionDeviceRow } from "./repository";

export type CompanionPairing = {
  readonly deviceId: string;
  readonly expiresAt: number;
  /** The QR as a self-contained SVG. It carries the one-time private key: show it, never log it. */
  readonly qrSvg: string;
  readonly hosts: ReadonlyArray<string>;
};

export type CompanionPairingRefusal = { readonly ok: false; readonly message: string };

export type CompanionServiceOptions = {
  readonly appVersion: string;
  readonly environment: () => Promise<CompanionEnvironment>;
  readonly authorizedKeysPath?: string;
  /** Settings' device list changed (paired, removed, swept, seen). */
  readonly onDevicesChanged?: (devices: ReadonlyArray<CompanionDeviceRecord>) => void;
  /** The first device exists: the operator socket must be listening. */
  readonly onFirstDevice?: () => void;
  /** Test seams; production runs the registry on the app runtime and reads the live app. */
  readonly runRepository?: <A, E>(effect: Effect.Effect<A, E, CompanionDeviceRepository>) => Promise<A>;
  readonly backend?: (deps: { readonly pairComplete: CompanionBackend["pairComplete"] }) => CompanionBackend;
};

export type CompanionService = {
  readonly changes: CompanionChanges;
  readonly dispatch: (request: OperatorRequestEnvelope) => Promise<OperatorResponseEnvelope | undefined>;
  readonly devices: () => Promise<ReadonlyArray<CompanionDeviceRecord>>;
  readonly hasDevices: () => Promise<boolean>;
  readonly startPairing: () => Promise<({ readonly ok: true } & CompanionPairing) | CompanionPairingRefusal>;
  readonly cancelPairing: (deviceId: string) => Promise<void>;
  readonly remove: (deviceId: string) => Promise<boolean>;
  /** Boot: drop expired pairings and any Junto key line with no record behind it. */
  readonly reconcile: () => Promise<void>;
  readonly environment: () => Promise<CompanionEnvironment>;
};

const publicRecord = ({ publicKey: _key, ...record }: CompanionDeviceRow): CompanionDeviceRecord => record;

const runOnApp = <A, E>(effect: Effect.Effect<A, E, CompanionDeviceRepository>): Promise<A> => AppRuntime.runPromise(effect);

const success = (
  request: { readonly id: string; readonly op: "companion.hello" | "companion.call" | "companion.events" },
  data: unknown,
): OperatorResponseEnvelope =>
  ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, ok: true, op: request.op, data }) as OperatorResponseEnvelope;

const decodePublicKey = Schema.decodeUnknownResult(CompanionPublicKey);

export const makeCompanionService = (options: CompanionServiceOptions): CompanionService => {
  const runRepository = options.runRepository ?? runOnApp;
  const repo = <A, E>(use: (repository: CompanionDeviceRepository["Service"]) => Effect.Effect<A, E>): Promise<A> =>
    runRepository(Effect.flatMap(CompanionDeviceRepository, use));
  const changes = makeCompanionChanges();
  const authorizedKeysPath = options.authorizedKeysPath ?? defaultAuthorizedKeysPath();
  const limiters = new Map<string, () => boolean>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let stationName: string | undefined;

  const devices = async (): Promise<ReadonlyArray<CompanionDeviceRecord>> =>
    (await repo((r) => r.list())).map(publicRecord);

  const announce = (): void => {
    if (!options.onDevicesChanged) return;
    void devices().then(options.onDevicesChanged, () => undefined);
  };

  const juntoPathOrThrow = async (): Promise<string> => {
    const environment = await options.environment();
    stationName = environment.station;
    if (!environment.juntoPath) throw new Error("the junto command is not installed");
    return environment.juntoPath;
  };

  const sweep = async (now = Date.now()): Promise<void> => {
    const expired = await repo((r) => r.removeExpired(now));
    if (expired.length === 0) return;
    for (const device of expired) {
      clearTimeout(expiryTimers.get(device.deviceId));
      expiryTimers.delete(device.deviceId);
      await editAuthorizedKeys((text) => removeCompanionKey(text, device.deviceId), authorizedKeysPath).catch(() => undefined);
    }
    announce();
  };

  /** The device a relayed op speaks for, or why it may not speak. */
  const admit = async (deviceId: string): Promise<CompanionDeviceRow | undefined> => {
    const device = await repo((r) => r.get(deviceId));
    if (device === undefined) return undefined;
    if (device.state === "pairing" && (device.pairingExpiresAt ?? 0) <= Date.now()) {
      await sweep();
      return undefined;
    }
    return device;
  };

  const touch = (device: CompanionDeviceRow): void => {
    if (device.state !== "paired") return;
    const before = device.lastSeenAt;
    void repo((r) => r.touch(device.deviceId, Date.now()))
      .then(() => repo((r) => r.get(device.deviceId)))
      .then((after) => {
        if (after?.lastSeenAt !== before) announce();
      })
      .catch(() => undefined);
  };

  const pairComplete = async (input: { readonly deviceId: string; readonly publicKey: string; readonly deviceName: string }) => {
    if (Result.isFailure(decodePublicKey(input.publicKey))) return outcomeFail<{ deviceId: string }>("invalid", "That key cannot be used.");
    const device = await repo((r) => r.get(input.deviceId));
    if (!device || device.state !== "pairing" || (device.pairingExpiresAt ?? 0) <= Date.now()) {
      return outcomeFail<{ deviceId: string }>("revoked", "This pairing code expired. Pair again from Junto on your Mac.");
    }
    const juntoPath = await juntoPathOrThrow();
    const line = companionKeyLine({ juntoPath, deviceId: input.deviceId, publicKey: input.publicKey });
    // The phone's key replaces the one-time key's line; the open pairing
    // session keeps working, and from now on only the phone's key does.
    await editAuthorizedKeys((text) => upsertCompanionKey(text, input.deviceId, line), authorizedKeysPath);
    const completed = await repo((r) =>
      r.completePairing({ deviceId: input.deviceId, publicKey: input.publicKey, name: input.deviceName, now: Date.now() }),
    );
    if (!completed.ok) {
      await editAuthorizedKeys((text) => removeCompanionKey(text, input.deviceId), authorizedKeysPath).catch(() => undefined);
      return outcomeFail<{ deviceId: string }>("revoked", "This pairing code expired. Pair again from Junto on your Mac.");
    }
    clearTimeout(expiryTimers.get(input.deviceId));
    expiryTimers.delete(input.deviceId);
    announce();
    return outcomeOk({ deviceId: input.deviceId });
  };

  const backend = (options.backend ?? makeMainCompanionBackend)({ pairComplete });

  const revoked = companionError("revoked", COMPANION_ERROR_COPY.revoked);

  const dispatch = async (request: OperatorRequestEnvelope): Promise<OperatorResponseEnvelope | undefined> => {
    if (request.op === "companion.hello") {
      const device = await admit(request.args.deviceId);
      if (!device) return success(request, { ok: false, error: revoked });
      touch(device);
      if (stationName === undefined) stationName = (await options.environment().catch(() => undefined))?.station;
      return success(request, {
        ok: true,
        hello: {
          appVersion: options.appVersion,
          deviceId: device.deviceId,
          deviceName: device.name,
          station: stationName ?? "Junto",
          serverTime: Date.now(),
        },
      });
    }
    if (request.op === "companion.call") {
      // Decoded by the operator request schema; the discriminated view is the same value.
      const frame = request.args.request as CompanionRequestFrame;
      const device = await admit(request.args.deviceId);
      if (!device) return success(request, { response: companionFail(frame.id, revoked) });
      touch(device);
      let allowWrite = limiters.get(device.deviceId);
      if (!allowWrite) {
        allowWrite = makeWriteLimiter();
        limiters.set(device.deviceId, allowWrite);
      }
      const response = await handleCompanionRequest(frame, {
        backend,
        device: { deviceId: device.deviceId, state: device.state },
        allowWrite,
      });
      return success(request, { response });
    }
    if (request.op === "companion.events") {
      const device = await admit(request.args.deviceId);
      if (!device || device.state !== "paired") return success(request, { ok: false, error: revoked });
      const change = await changes.wait(request.args.cursor, request.args.waitMs);
      // Still paired when the wait ends: a phone removed mid-poll hears it next call.
      return success(request, { ok: true, ...change });
    }
    return undefined;
  };

  const startPairing = async () => {
    const environment = await options.environment();
    stationName = environment.station;
    if (!environment.juntoPath) return { ok: false as const, message: "The junto command is not installed on this Mac." };
    if (!environment.hostKey) return { ok: false as const, message: "This Mac has no SSH host key yet. Turn on Remote Login first." };
    if (environment.hosts.length === 0) return { ok: false as const, message: "This Mac has no network address a phone can reach." };
    await sweep();
    const deviceId = `dev_${ulid()}`;
    const key = generatePairingKey();
    const now = Date.now();
    const expiresAt = now + COMPANION_PAIRING_TTL_MS;
    const hadDevices = (await repo((r) => r.list())).length > 0;
    await repo((r) => r.createPairing({ deviceId, pairingPublicKey: key.publicKey, expiresAt, now }));
    try {
      const line = companionKeyLine({ juntoPath: environment.juntoPath, deviceId, publicKey: key.publicKey });
      await editAuthorizedKeys((text) => upsertCompanionKey(text, deviceId, line), authorizedKeysPath);
    } catch (error) {
      await repo((r) => r.remove(deviceId)).catch(() => undefined);
      return { ok: false as const, message: error instanceof Error ? `Could not update authorized_keys: ${error.message}` : "Could not update authorized_keys." };
    }
    expiryTimers.set(
      deviceId,
      setTimeout(() => void sweep().catch(() => undefined), COMPANION_PAIRING_TTL_MS + 1_000),
    );
    if (!hadDevices) options.onFirstDevice?.();
    const url = companionPairingUrl({
      v: COMPANION_PROTOCOL,
      deviceId,
      station: environment.station,
      hosts: environment.hosts,
      port: 22,
      user: environment.user,
      hostKey: environment.hostKey,
      pairingKey: key.privateKey,
      expiresAt,
    });
    const qrSvg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "L", margin: 2 });
    announce();
    return { ok: true as const, deviceId, expiresAt, qrSvg, hosts: environment.hosts };
  };

  const remove = async (deviceId: string): Promise<boolean> => {
    clearTimeout(expiryTimers.get(deviceId));
    expiryTimers.delete(deviceId);
    await editAuthorizedKeys((text) => removeCompanionKey(text, deviceId), authorizedKeysPath);
    const removed = await repo((r) => r.remove(deviceId));
    limiters.delete(deviceId);
    announce();
    return removed !== undefined;
  };

  return {
    changes,
    dispatch,
    devices,
    hasDevices: async () => (await repo((r) => r.list())).length > 0,
    startPairing,
    cancelPairing: async (deviceId) => {
      const device = await repo((r) => r.get(deviceId));
      if (device?.state === "pairing") await remove(deviceId);
    },
    remove,
    reconcile: async () => {
      await sweep();
      const keep = new Set((await repo((r) => r.list())).map((device) => device.deviceId));
      for (const device of await repo((r) => r.list())) {
        if (device.state === "pairing" && device.pairingExpiresAt !== undefined) {
          expiryTimers.set(
            device.deviceId,
            setTimeout(() => void sweep().catch(() => undefined), Math.max(0, device.pairingExpiresAt - Date.now()) + 1_000),
          );
        }
      }
      await editAuthorizedKeys((text) => pruneCompanionKeys(text, keep), authorizedKeysPath).catch(() => undefined);
    },
    environment: options.environment,
  };
};

/** The process's companion, created by main at startup. */
let instance: CompanionService | undefined;
export const setCompanionService = (service: CompanionService): void => {
  instance = service;
};
export const companionService = (): CompanionService | undefined => instance;

export { readCompanionEnvironment };
