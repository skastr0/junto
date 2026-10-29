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
 * - Remove deletes the record, then the authorized_keys line.
 * - A paired phone whose line is gone is detected (on reconcile, and when
 *   ~/.ssh changes) and only marked: Junto cannot tell a lost line from one
 *   the operator or a security tool removed, so it never writes the line back
 *   by itself. Restore is a click in Settings, Companion, and nothing else: no
 *   phone op, no operator socket, no link op reaches it.
 *
 * authorized_keys is edited only through `authorized-keys.ts`, which touches
 * nothing but `junto-companion:` lines. Key logs carry the device id, the
 * outcome and a closed reason, never a key or a line.
 */

import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { Effect, Result, Schema } from "effect";
import QRCode from "qrcode";
import { ulid } from "ulid";
import {
  handleCompanionRequest,
  makeCompanionGates,
  releaseCompanionUploads,
  makeWriteLimiter,
  outcomeFail,
  outcomeOk,
  type CompanionBackend,
  type CompanionGates,
} from "@shared/companion-core";
import type { CompanionDeviceRecord, CompanionKeyFailure, CompanionKeyRestore } from "@shared/companion-devices";
import {
  COMPANION_FEATURES,
  COMPANION_HELLO_HOSTS_MAX,
  COMPANION_PAIRING_TTL_MS,
  isCompanionHost,
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
  AuthorizedKeysError,
  companionDevicesIn,
  companionKeyLine,
  companionAuthorizedKeysPath,
  editAuthorizedKeys,
  isCompanionPublicKey,
  pruneCompanionKeys,
  readAuthorizedKeys,
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

/** The system clipboard, as much of it as Copy link needs. */
export type CompanionClipboard = {
  readonly readText: () => string;
  readonly writeText: (text: string) => void;
  readonly clear: () => void;
};

export type CompanionServiceOptions = {
  readonly appVersion: string;
  readonly environment: () => Promise<CompanionEnvironment>;
  /** Default: the user's own, only when Junto's home is the user's home. null: none. */
  readonly authorizedKeysPath?: string | null;
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
  /**
   * Copy link: put a pending pairing's link on the clipboard. It is taken off
   * again when that pairing completes, expires or is cancelled, but only if
   * the clipboard still holds exactly that link. False when the pairing is
   * gone or expired.
   */
  readonly copyLink: (deviceId: string, clipboard: CompanionClipboard) => boolean;
  readonly remove: (deviceId: string) => Promise<boolean>;
  /**
   * Settings only: write back the line of a paired phone marked `missing`, or
   * of every one ("all"), from its stored key. Never a pairing device.
   */
  readonly restore: (target: string) => Promise<CompanionKeyRestore>;
  /**
   * Boot: drop expired pairings and any Junto key line with no record behind
   * it, mark paired phones whose line is gone, and start watching ~/.ssh.
   */
  readonly reconcile: () => Promise<void>;
  readonly environment: () => Promise<CompanionEnvironment>;
  /** Stop watching ~/.ssh. */
  readonly close: () => void;
};

const publicRecord = ({ publicKey: _key, ...record }: CompanionDeviceRow): CompanionDeviceRecord => record;

/** A change to ~/.ssh settles this long before the lines are read again. */
const KEY_WATCH_SETTLE_MS = 250;

type KeyLog = {
  readonly deviceId: string;
  readonly outcome: "missing" | "found" | "restored" | "restore-failed" | "removed" | "remove-failed";
  readonly reason?: CompanionKeyFailure;
  /** An io failure only: the file and the errno code, nothing read from it. */
  readonly path?: string;
  readonly code?: string;
};

const logKey = (entry: KeyLog): void => {
  const detail = [entry.reason, entry.path, entry.code].filter((part) => part !== undefined).join(" ");
  const line = `[companion] key ${entry.outcome} ${entry.deviceId}${detail ? ` ${detail}` : ""}`;
  if (entry.outcome === "restore-failed" || entry.outcome === "remove-failed" || entry.outcome === "missing") console.warn(line);
  else console.info(line);
};

/**
 * A failed write, as the closed reason and, for io, the path and errno code.
 * The stored key is checked before any write, so an invalid line at this
 * point is the junto path, never the phone's key.
 */
const keyFailure = (error: unknown, path: string): Pick<KeyLog, "reason" | "path" | "code"> & { readonly reason: CompanionKeyFailure } => {
  if (error instanceof AuthorizedKeysError) {
    if (error.reason === "symlink") return { reason: "symlink" };
    if (error.reason === "invalid") return { reason: "junto-path" };
    return { reason: "io", path };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return { reason: "io", path, ...(typeof code === "string" && /^E[A-Z0-9]{1,20}$/u.test(code) ? { code } : {}) };
};

const runOnApp = <A, E>(effect: Effect.Effect<A, E, CompanionDeviceRepository>): Promise<A> => AppRuntime.runPromise(effect);

const success = (
  request: { readonly id: string; readonly op: "companion.hello" | "companion.call" | "companion.events" },
  data: unknown,
): OperatorResponseEnvelope =>
  ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, ok: true, op: request.op, data }) as OperatorResponseEnvelope;

const decodePublicKey = Schema.decodeUnknownResult(CompanionPublicKey);

const HELLO_ENVIRONMENT_TTL_MS = 60_000;

export const makeCompanionService = (options: CompanionServiceOptions): CompanionService => {
  const runRepository = options.runRepository ?? runOnApp;
  const repo = <A, E>(use: (repository: CompanionDeviceRepository["Service"]) => Effect.Effect<A, E>): Promise<A> =>
    runRepository(Effect.flatMap(CompanionDeviceRepository, use));
  const changes = makeCompanionChanges();
  // null: this process may not edit authorized_keys at all (a Junto with its own home).
  const authorizedKeysPath = options.authorizedKeysPath === undefined ? companionAuthorizedKeysPath() : options.authorizedKeysPath ?? undefined;
  const editKeys = (edit: (text: string) => string): Promise<void> =>
    authorizedKeysPath === undefined ? Promise.resolve() : editAuthorizedKeys(edit, authorizedKeysPath).then(() => undefined);
  const limiters = new Map<string, () => boolean>();
  const gates = new Map<string, CompanionGates>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Pending pairing links stay in main; the renderer only ever gets the QR.
  const links = new Map<string, { readonly url: string; readonly expiresAt: number }>();
  let copied: { readonly deviceId: string; readonly url: string; readonly clipboard: CompanionClipboard } | undefined;

  /** The pairing is over: forget its link, and take it off the clipboard if it is still there. */
  const forgetLink = (deviceId: string): void => {
    links.delete(deviceId);
    if (copied?.deviceId !== deviceId) return;
    const { url, clipboard } = copied;
    copied = undefined;
    try {
      if (clipboard.readText() === url) clipboard.clear();
    } catch {
      // A clipboard we cannot read is left alone: never clobber something else.
    }
  };
  let stationName: string | undefined;
  // A hello reads where this Mac answers now, at most once a minute.
  let helloRead: { readonly at: number; readonly environment: Promise<CompanionEnvironment | undefined> } | undefined;
  const helloEnvironment = (): Promise<CompanionEnvironment | undefined> => {
    const now = Date.now();
    if (helloRead === undefined || now - helloRead.at >= HELLO_ENVIRONMENT_TTL_MS) {
      helloRead = { at: now, environment: options.environment().catch(() => undefined) };
    }
    return helloRead.environment;
  };

  // Paired phones whose line is gone, as last read. Detection only marks.
  const keyStates = new Map<string, "missing" | "damaged">();
  let keyWatcher: FSWatcher | undefined;
  let keyWatchTimer: ReturnType<typeof setTimeout> | undefined;

  const devices = async (): Promise<ReadonlyArray<CompanionDeviceRecord>> =>
    (await repo((r) => r.list())).map((row) => {
      const key = keyStates.get(row.deviceId);
      return key === undefined ? publicRecord(row) : { ...publicRecord(row), key };
    });

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

  /**
   * Read authorized_keys and mark every paired phone without its line. Writes
   * nothing: no line, no record, no state. A file Junto may not read (a
   * symlink) leaves the marks as they were.
   */
  const detectMissingKeys = async (): Promise<void> => {
    if (authorizedKeysPath === undefined) return;
    let present: ReadonlySet<string>;
    try {
      present = new Set(companionDevicesIn(readAuthorizedKeys(authorizedKeysPath)));
    } catch {
      return;
    }
    const next = new Map<string, "missing" | "damaged">();
    for (const device of await repo((r) => r.list())) {
      if (device.state !== "paired" || present.has(device.deviceId)) continue;
      next.set(device.deviceId, isCompanionPublicKey(device.publicKey) ? "missing" : "damaged");
    }
    let changed = false;
    for (const [deviceId, state] of next) {
      if (keyStates.get(deviceId) === state) continue;
      changed = true;
      logKey({ deviceId, outcome: "missing", reason: state });
    }
    for (const deviceId of keyStates.keys()) {
      if (next.has(deviceId)) continue;
      changed = true;
      logKey({ deviceId, outcome: "found" });
    }
    keyStates.clear();
    for (const [deviceId, state] of next) keyStates.set(deviceId, state);
    if (changed) announce();
  };

  /** Watch ~/.ssh: the file is replaced by rename, so the directory is what changes. */
  const watchKeys = (): void => {
    if (authorizedKeysPath === undefined || keyWatcher !== undefined) return;
    const name = basename(authorizedKeysPath);
    try {
      keyWatcher = watch(dirname(authorizedKeysPath), { persistent: false }, (_event, file) => {
        if (file !== null && file !== name) return;
        clearTimeout(keyWatchTimer);
        keyWatchTimer = setTimeout(() => void detectMissingKeys().catch(() => undefined), KEY_WATCH_SETTLE_MS);
      });
      keyWatcher.on("error", () => {
        keyWatcher?.close();
        keyWatcher = undefined;
      });
    } catch {
      // No ~/.ssh yet: the next reconcile, pairing or Restore looks again.
      keyWatcher = undefined;
    }
  };

  const sweep = async (now = Date.now()): Promise<void> => {
    const expired = await repo((r) => r.removeExpired(now));
    if (expired.length === 0) return;
    for (const device of expired) {
      clearTimeout(expiryTimers.get(device.deviceId));
      expiryTimers.delete(device.deviceId);
      forgetLink(device.deviceId);
      await editKeys((text) => removeCompanionKey(text, device.deviceId)).catch(() => undefined);
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
    await editKeys((text) => upsertCompanionKey(text, input.deviceId, line));
    const completed = await repo((r) =>
      r.completePairing({ deviceId: input.deviceId, publicKey: input.publicKey, name: input.deviceName, now: Date.now() }),
    );
    if (!completed.ok) {
      await editKeys((text) => removeCompanionKey(text, input.deviceId)).catch(() => undefined);
      return outcomeFail<{ deviceId: string }>("revoked", "This pairing code expired. Pair again from Junto on your Mac.");
    }
    clearTimeout(expiryTimers.get(input.deviceId));
    expiryTimers.delete(input.deviceId);
    forgetLink(input.deviceId);
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
      const environment = await helloEnvironment();
      if (environment !== undefined) stationName = environment.station;
      const hosts = environment?.hosts.filter(isCompanionHost).slice(0, COMPANION_HELLO_HOSTS_MAX) ?? [];
      return success(request, {
        ok: true,
        hello: {
          appVersion: options.appVersion,
          deviceId: device.deviceId,
          deviceName: device.name,
          station: stationName ?? "Junto",
          ...(hosts.length === 0 ? {} : { hosts }),
          features: COMPANION_FEATURES,
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
      let deviceGates = gates.get(device.deviceId);
      if (!deviceGates) {
        deviceGates = makeCompanionGates();
        gates.set(device.deviceId, deviceGates);
      }
      const response = await handleCompanionRequest(frame, {
        backend,
        device: { deviceId: device.deviceId, state: device.state },
        allowWrite,
        gates: deviceGates,
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
    if (authorizedKeysPath === undefined)
      return { ok: false as const, message: "This Junto runs from its own home, so it cannot pair phones. Pair from the Junto you use every day." };
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
      await editKeys((text) => upsertCompanionKey(text, deviceId, line));
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
    links.set(deviceId, { url, expiresAt });
    const qrSvg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "L", margin: 4 });
    announce();
    return { ok: true as const, deviceId, expiresAt, qrSvg, hosts: environment.hosts };
  };

  // The record goes first, so the phone is refused even if the line cannot
  // be taken out; a line left behind has no record and the next reconcile
  // prunes it.
  const remove = async (deviceId: string): Promise<boolean> => {
    clearTimeout(expiryTimers.get(deviceId));
    expiryTimers.delete(deviceId);
    forgetLink(deviceId);
    const removed = await repo((r) => r.remove(deviceId));
    limiters.delete(deviceId);
    const deviceGates = gates.get(deviceId);
    gates.delete(deviceId);
    // Its open uploads are dropped and the finished ones it never used let go.
    if (deviceGates) void releaseCompanionUploads(backend, deviceGates.uploads);
    const wasMarked = keyStates.delete(deviceId);
    announce();
    try {
      await editKeys((text) => removeCompanionKey(text, deviceId));
    } catch (error) {
      if (authorizedKeysPath !== undefined) logKey({ deviceId, outcome: "remove-failed", ...keyFailure(error, authorizedKeysPath) });
      throw new Error("The phone was removed, but its line could not be taken out of authorized_keys. Junto takes it out at the next start.");
    }
    if (removed?.state === "paired") logKey({ deviceId, outcome: "removed", ...(wasMarked ? { reason: "missing" as const } : {}) });
    return removed !== undefined;
  };

  const restore = async (target: string): Promise<CompanionKeyRestore> => {
    if (authorizedKeysPath === undefined) {
      return { ok: false, restored: [], failed: [], message: "This Junto runs from its own home, so it cannot restore phones." };
    }
    const path = authorizedKeysPath;
    await detectMissingKeys();
    const wanted = target === "all" ? [...keyStates.keys()] : [target];
    const rows = new Map((await repo((r) => r.list())).map((row) => [row.deviceId, row]));
    const restored: string[] = [];
    const failed: Array<{ readonly deviceId: string; readonly reason: CompanionKeyFailure }> = [];
    let juntoPath: string | undefined;
    let juntoMissing = false;
    for (const deviceId of wanted) {
      const device = rows.get(deviceId);
      const state = keyStates.get(deviceId);
      // Only a paired phone marked missing: never a pairing, never a phone whose line is there.
      if (device === undefined || device.state !== "paired" || state === undefined) continue;
      if (state === "damaged" || !isCompanionPublicKey(device.publicKey)) {
        failed.push({ deviceId, reason: "damaged" });
        logKey({ deviceId, outcome: "restore-failed", reason: "damaged" });
        continue;
      }
      try {
        juntoPath ??= await juntoPathOrThrow();
        const line = companionKeyLine({ juntoPath, deviceId, publicKey: device.publicKey });
        // Same writer as pairing; a line put back meanwhile is left as it is.
        await editAuthorizedKeys(
          (text) => (companionDevicesIn(text).includes(deviceId) ? text : upsertCompanionKey(text, deviceId, line)),
          path,
        );
        restored.push(deviceId);
        logKey({ deviceId, outcome: "restored" });
      } catch (error) {
        juntoMissing ||= juntoPath === undefined;
        const failure = juntoPath === undefined ? { reason: "io" as const } : keyFailure(error, path);
        failed.push({ deviceId, reason: failure.reason });
        logKey({ deviceId, outcome: "restore-failed", ...failure });
      }
    }
    await detectMissingKeys();
    watchKeys();
    announce();
    return {
      ok: failed.length === 0,
      restored,
      failed,
      ...(juntoMissing ? { message: "The junto command is not installed on this Mac." } : {}),
    };
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
    restore,
    copyLink: (deviceId, clipboard) => {
      const link = links.get(deviceId);
      if (!link || link.expiresAt <= Date.now()) return false;
      clipboard.writeText(link.url);
      copied = { deviceId, url: link.url, clipboard };
      return true;
    },
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
      await editKeys((text) => pruneCompanionKeys(text, keep)).catch(() => undefined);
      await detectMissingKeys();
      watchKeys();
    },
    environment: options.environment,
    close: () => {
      clearTimeout(keyWatchTimer);
      keyWatcher?.close();
      keyWatcher = undefined;
    },
  };
};

/** The process's companion, created by main at startup. */
let instance: CompanionService | undefined;
export const setCompanionService = (service: CompanionService): void => {
  instance = service;
};
export const companionService = (): CompanionService | undefined => instance;

export { readCompanionEnvironment };

/**
 * The e2e harness pins this Mac's pairing facts (Remote Login, host key,
 * hosts, the junto command) so a pairing scenario does not depend on the
 * machine it runs on. Honoured only in a harness run (JUNTO_E2E=1, which
 * also sandboxes HOME, so authorized_keys is the sandbox's).
 */
export const companionE2eEnvironment = (): Promise<CompanionEnvironment> | undefined => {
  const raw = process.env.JUNTO_E2E === "1" ? process.env.JUNTO_E2E_COMPANION_ENVIRONMENT : undefined;
  if (!raw) return undefined;
  try {
    return Promise.resolve(JSON.parse(raw) as CompanionEnvironment);
  } catch {
    return undefined;
  }
};
