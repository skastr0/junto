import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Effect } from "effect";
import {
  BROWSER_HOST_CAPABILITY,
  hostHasCapability,
  type RemoteHost,
} from "@shared/remote-hosts";
import {
  canonicalStationBrowserJson,
  isStationBrowserKeyId,
} from "@shared/station-browser";
import {
  makeRemoteStdin,
  parseSshEndpoint,
  type SshError,
} from "../ssh/domain";
import { oneShotWithStdin } from "../ssh/program";
import { remoteVellumBrowserStationTrust } from "../ssh/read-commands";
import type { SshTransport } from "../ssh/service";
import type { StationBrowserTrust } from "./station-delegation";

export const STATION_BROWSER_TRUST_VERSION = 1 as const;
export const STATION_BROWSER_TRUST_DIRECTORY_MODE = 0o700;
export const STATION_BROWSER_TRUST_FILE_MODE = 0o600;
export const STATION_BROWSER_TRUST_MAX_BYTES = 16 * 1024;
export const STATION_BROWSER_TRUST_WRAPPER = "vellum-browser";
export const STATION_BROWSER_TRUST_WRAPPER_ARGS = ["station-trust"] as const;

const ROOT_LEAF = "station-browser";
const ORIGIN_KEY_LEAF = "origin-key.json";
const PINNED_TRUST_PATTERN = /^pinned-origin\.([0-9]{10})\.json$/;
const MAX_PINNED_TRUST_RECORDS = 128;
const MAX_KEY_GENERATION = 1_000_000_000;

const canonicalStationId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);

const safeInteger = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0;

const exactKeys = (
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => key in value);

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const currentUid = (): number => {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("station browser trust requires a POSIX user identity");
  }
  return uid;
};

const mode = (value: number): number => value & 0o777;

const validateDirectory = async (
  path: string,
  expectedMode?: number,
): Promise<void> => {
  const before = await lstat(path);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    before.uid !== currentUid()
  ) {
    throw new Error("station browser trust path is not a current-user real directory");
  }
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (expectedMode !== undefined) {
      await handle.chmod(expectedMode);
    }
    const opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      opened.uid !== before.uid ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (expectedMode !== undefined && mode(opened.mode) !== expectedMode)
    ) {
      throw new Error("station browser trust directory changed during validation");
    }
  } finally {
    await handle.close();
  }
};

const ensureDirectory = async (
  path: string,
  expectedMode: number,
): Promise<void> => {
  try {
    await mkdir(path, { mode: expectedMode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await validateDirectory(path, expectedMode);
};

const ensureTrustRoot = async (home: string): Promise<string> => {
  if (!isAbsolute(home) || home.length > 4_096 || /[\u0000-\u001f\u007f]/.test(home)) {
    throw new Error("station browser trust home must be a bounded absolute path");
  }
  await validateDirectory(home);
  const vellum = join(home, ".vellum");
  await ensureDirectory(vellum, STATION_BROWSER_TRUST_DIRECTORY_MODE);
  const root = join(vellum, ROOT_LEAF);
  await ensureDirectory(root, STATION_BROWSER_TRUST_DIRECTORY_MODE);
  return root;
};

const readOwnerFile = async (
  path: string,
): Promise<string | undefined> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== currentUid() ||
      before.nlink !== 1 ||
      mode(before.mode) !== STATION_BROWSER_TRUST_FILE_MODE ||
      before.size < 2 ||
      before.size > STATION_BROWSER_TRUST_MAX_BYTES
    ) {
      throw new Error("station browser trust record is not an owner-private regular file");
    }
    const body = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("station browser trust record changed while it was read");
    }
    return body;
  } finally {
    await handle.close();
  }
};

const atomicOwnerWrite = async (
  path: string,
  body: string,
  replace = true,
): Promise<void> => {
  if (Buffer.byteLength(body, "utf8") > STATION_BROWSER_TRUST_MAX_BYTES) {
    throw new Error("station browser trust record exceeds its byte boundary");
  }
  await validateDirectory(dirname(path), STATION_BROWSER_TRUST_DIRECTORY_MODE);
  const temporary = join(
    dirname(path),
    `.${randomBytes(16).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      STATION_BROWSER_TRUST_FILE_MODE,
    );
    await handle.writeFile(body, "utf8");
    await handle.chmod(STATION_BROWSER_TRUST_FILE_MODE);
    await handle.sync();
    const written = await handle.stat();
    if (
      !written.isFile() ||
      written.uid !== currentUid() ||
      written.nlink !== 1 ||
      mode(written.mode) !== STATION_BROWSER_TRUST_FILE_MODE
    ) {
      throw new Error("station browser trust temporary record is not owner-private");
    }
    await handle.close();
    handle = undefined;
    const pathBefore = await lstat(temporary);
    if (
      pathBefore.isSymbolicLink() ||
      !pathBefore.isFile() ||
      pathBefore.dev !== written.dev ||
      pathBefore.ino !== written.ino
    ) {
      throw new Error("station browser trust temporary path changed");
    }
    if (replace) {
      await rename(temporary, path);
    } else {
      // Link publishes a new immutable generation without an overwrite race.
      // Removing the temporary name leaves the admitted final inode at nlink=1.
      await link(temporary, path);
      await unlink(temporary);
    }
    const final = await lstat(path);
    if (
      final.isSymbolicLink() ||
      !final.isFile() ||
      final.uid !== currentUid() ||
      final.nlink !== 1 ||
      mode(final.mode) !== STATION_BROWSER_TRUST_FILE_MODE
    ) {
      throw new Error("station browser trust record permissions are insecure");
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
};

const base64 = (bytes: Buffer): string => bytes.toString("base64");
const decodeBase64 = (value: unknown): Buffer => {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 1_024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("station browser key material is malformed");
  }
  return Buffer.from(value, "base64");
};

const keyIdFor = (publicDer: Buffer): string =>
  `ed25519-${createHash("sha256").update(publicDer).digest("hex").slice(0, 24)}`;

interface OriginKeyRecord {
  readonly version: 1;
  readonly generation: number;
  readonly keyId: string;
  readonly originStationId: string;
  readonly createdAt: number;
  readonly privateKeyPkcs8: string;
  readonly publicKeySpki: string;
}

declare const originKeyBrand: unique symbol;
export interface StationBrowserOriginKey {
  readonly [originKeyBrand]: never;
  readonly generation: number;
  readonly keyId: string;
  readonly originStationId: string;
  readonly createdAt: number;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

type OriginKeyState = Readonly<{
  home: string;
  record: OriginKeyRecord;
}>;
const originKeys = new WeakMap<object, OriginKeyState>();

const decodeOriginRecord = (source: string): OriginKeyRecord => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("station browser origin key record is not JSON");
  }
  const keys = [
    "version",
    "generation",
    "keyId",
    "originStationId",
    "createdAt",
    "privateKeyPkcs8",
    "publicKeySpki",
  ];
  if (
    !plain(value) ||
    !exactKeys(value, keys) ||
    value.version !== 1 ||
    !safeInteger(value.generation) ||
    value.generation < 1 ||
    value.generation > MAX_KEY_GENERATION ||
    !isStationBrowserKeyId(value.keyId) ||
    !canonicalStationId(value.originStationId) ||
    !safeInteger(value.createdAt)
  ) {
    throw new Error("station browser origin key record is malformed");
  }
  decodeBase64(value.privateKeyPkcs8);
  decodeBase64(value.publicKeySpki);
  return value as unknown as OriginKeyRecord;
};

const materializeOriginKey = (
  home: string,
  record: OriginKeyRecord,
): StationBrowserOriginKey => {
  const privateKey = createPrivateKey({
    key: decodeBase64(record.privateKeyPkcs8),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey({
    key: decodeBase64(record.publicKeySpki),
    format: "der",
    type: "spki",
  });
  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519" ||
    publicKey.type !== "public" ||
    publicKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("station browser origin key must be Ed25519");
  }
  const derived = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  }) as Buffer;
  const supplied = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  if (
    !derived.equals(supplied) ||
    record.keyId !== keyIdFor(supplied)
  ) {
    throw new Error("station browser origin key pair is inconsistent");
  }
  const key = Object.freeze({
    generation: record.generation,
    keyId: record.keyId,
    originStationId: record.originStationId,
    createdAt: record.createdAt,
    privateKey,
    publicKey,
  }) as StationBrowserOriginKey;
  originKeys.set(key, { home, record });
  return key;
};

const createOriginRecord = (
  originStationId: string,
  generation: number,
  createdAt: number,
): OriginKeyRecord => {
  if (
    !canonicalStationId(originStationId) ||
    !safeInteger(generation) ||
    generation < 1 ||
    generation > MAX_KEY_GENERATION ||
    !safeInteger(createdAt)
  ) {
    throw new Error("station browser origin key parameters are invalid");
  }
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPkcs8 = pair.privateKey.export({
    format: "der",
    type: "pkcs8",
  }) as Buffer;
  const publicKeySpki = pair.publicKey.export({
    format: "der",
    type: "spki",
  }) as Buffer;
  return {
    version: 1,
    generation,
    keyId: keyIdFor(publicKeySpki),
    originStationId,
    createdAt,
    privateKeyPkcs8: base64(privateKeyPkcs8),
    publicKeySpki: base64(publicKeySpki),
  };
};

export type StationBrowserPinnedTrustRecord = Readonly<{
  version: 1;
  generation: number;
  keyId: string;
  originStationId: string;
  status: "active" | "revoked";
  publicKeySpki: string | null;
  replacesKeyId: string | null;
  updatedAt: number;
}>;

const decodePinnedRecordValue = (
  value: unknown,
): StationBrowserPinnedTrustRecord => {
  if (
    !plain(value) ||
    !exactKeys(value, [
      "version",
      "generation",
      "keyId",
      "originStationId",
      "status",
      "publicKeySpki",
      "replacesKeyId",
      "updatedAt",
    ]) ||
    value.version !== 1 ||
    !safeInteger(value.generation) ||
    value.generation < 1 ||
    value.generation > MAX_KEY_GENERATION ||
    !isStationBrowserKeyId(value.keyId) ||
    !canonicalStationId(value.originStationId) ||
    (value.status !== "active" && value.status !== "revoked") ||
    (value.replacesKeyId !== null && !isStationBrowserKeyId(value.replacesKeyId)) ||
    !safeInteger(value.updatedAt)
  ) {
    throw new Error("station browser pinned trust record is malformed");
  }
  if (value.status === "revoked") {
    if (value.publicKeySpki !== null) {
      throw new Error("revoked station browser trust cannot retain an active public key");
    }
  } else {
    const publicDer = decodeBase64(value.publicKeySpki);
    const publicKey = createPublicKey({
      key: publicDer,
      format: "der",
      type: "spki",
    });
    if (
      publicKey.type !== "public" ||
      publicKey.asymmetricKeyType !== "ed25519" ||
      value.keyId !== keyIdFor(publicDer)
    ) {
      throw new Error("station browser pinned trust must contain its exact Ed25519 key");
    }
  }
  return value as unknown as StationBrowserPinnedTrustRecord;
};

export const decodeStationBrowserPinnedTrustRecord = (
  frame: string,
): StationBrowserPinnedTrustRecord => {
  if (
    Buffer.byteLength(frame, "utf8") > STATION_BROWSER_TRUST_MAX_BYTES
  ) {
    throw new Error("station browser pinned trust frame exceeds its byte boundary");
  }
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    throw new Error("station browser pinned trust frame is not JSON");
  }
  const record = decodePinnedRecordValue(value);
  if (canonicalStationBrowserJson(record) !== frame.trim()) {
    throw new Error("station browser pinned trust frame is not canonical");
  }
  return record;
};

export const pinnedTrustForOriginKey = (
  key: StationBrowserOriginKey,
  replacesKeyId: string | null = null,
  updatedAt = Date.now(),
): StationBrowserPinnedTrustRecord => {
  const state = originKeys.get(key);
  if (state === undefined || !safeInteger(updatedAt)) {
    throw new Error("station browser trust requires a custody-owned origin key");
  }
  return Object.freeze({
    version: 1,
    generation: key.generation,
    keyId: key.keyId,
    originStationId: key.originStationId,
    status: "active",
    publicKeySpki: state.record.publicKeySpki,
    replacesKeyId,
    updatedAt,
  });
};

export const revokePinnedTrust = (
  current: StationBrowserPinnedTrustRecord,
  updatedAt = Date.now(),
): StationBrowserPinnedTrustRecord => {
  const admitted = decodePinnedRecordValue(current);
  if (
    admitted.status !== "active" ||
    admitted.generation >= MAX_KEY_GENERATION ||
    !safeInteger(updatedAt)
  ) {
    throw new Error("only current active station browser trust can be revoked");
  }
  return Object.freeze({
    version: 1,
    generation: admitted.generation + 1,
    keyId: admitted.keyId,
    originStationId: admitted.originStationId,
    status: "revoked",
    publicKeySpki: null,
    replacesKeyId: admitted.keyId,
    updatedAt,
  });
};

export const makeStationBrowserTrustStore = (
  home = homedir(),
) => {
  let mutation: Promise<void> = Promise.resolve();
  const serialized = async <A>(operation: () => Promise<A>): Promise<A> => {
    const prior = mutation;
    let release!: () => void;
    mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const originPath = async (): Promise<string> =>
    join(await ensureTrustRoot(home), ORIGIN_KEY_LEAF);
  const pinnedPath = async (generation: number): Promise<string> =>
    join(
      await ensureTrustRoot(home),
      `pinned-origin.${String(generation).padStart(10, "0")}.json`,
    );

  const readOriginRecord = async (): Promise<OriginKeyRecord | undefined> => {
    const body = await readOwnerFile(await originPath());
    return body === undefined ? undefined : decodeOriginRecord(body);
  };

  const loadOrCreateOriginKey = (
    originStationId: string,
    now = Date.now(),
  ): Promise<StationBrowserOriginKey> =>
    serialized(async () => {
      const existing = await readOriginRecord();
      if (existing !== undefined) {
        if (existing.originStationId !== originStationId) {
          throw new Error("station browser origin key is pinned to another station");
        }
        return materializeOriginKey(home, existing);
      }
      const created = createOriginRecord(originStationId, 1, now);
      await atomicOwnerWrite(
        await originPath(),
        `${canonicalStationBrowserJson(created)}\n`,
      );
      return materializeOriginKey(home, created);
    });

  const rotateOriginKey = (
    current: StationBrowserOriginKey,
    now = Date.now(),
  ): Promise<StationBrowserOriginKey> =>
    serialized(async () => {
      const state = originKeys.get(current);
      if (state === undefined || state.home !== home) {
        throw new Error("station browser origin-key rotation requires current custody");
      }
      const persisted = await readOriginRecord();
      if (
        persisted === undefined ||
        persisted.keyId !== state.record.keyId ||
        persisted.generation !== state.record.generation ||
        persisted.originStationId !== state.record.originStationId
      ) {
        throw new Error("station browser origin key changed before rotation");
      }
      if (persisted.generation >= MAX_KEY_GENERATION) {
        throw new Error("station browser origin key generation is exhausted");
      }
      const next = createOriginRecord(
        persisted.originStationId,
        persisted.generation + 1,
        now,
      );
      await atomicOwnerWrite(
        await originPath(),
        `${canonicalStationBrowserJson(next)}\n`,
      );
      return materializeOriginKey(home, next);
    });

  const readPinnedRecord =
    async (): Promise<StationBrowserPinnedTrustRecord | undefined> => {
      const root = await ensureTrustRoot(home);
      const entries = await readdir(root, { withFileTypes: true });
      const generations = entries.flatMap((entry) => {
        const match = entry.name.match(PINNED_TRUST_PATTERN);
        if (match === null) return [];
        if (
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          match[1] === undefined
        ) {
          throw new Error("station browser pinned trust ledger is malformed");
        }
        return [{ name: entry.name, generation: Number(match[1]) }];
      });
      if (generations.length > MAX_PINNED_TRUST_RECORDS) {
        throw new Error("station browser pinned trust ledger exceeds its record boundary");
      }
      generations.sort((left, right) => right.generation - left.generation);
      const latest = generations[0];
      if (latest === undefined) return undefined;
      const body = await readOwnerFile(join(root, latest.name));
      if (body === undefined) {
        throw new Error("station browser pinned trust generation disappeared");
      }
      const record = decodeStationBrowserPinnedTrustRecord(body.trim());
      if (record.generation !== latest.generation) {
        throw new Error("station browser pinned trust generation does not match its ledger name");
      }
      return record;
    };

  const installPinnedRecord = (
    next: StationBrowserPinnedTrustRecord,
  ): Promise<StationBrowserPinnedTrustRecord> =>
    serialized(async () => {
      const admitted = decodePinnedRecordValue(next);
      const current = await readPinnedRecord();
      const currentWire =
        current === undefined ? undefined : canonicalStationBrowserJson(current);
      const nextWire = canonicalStationBrowserJson(admitted);
      if (
        current !== undefined &&
        admitted.generation === current.generation &&
        nextWire === currentWire
      ) {
        return current;
      }
      if (
        current !== undefined &&
        (
          admitted.generation <= current.generation ||
          admitted.originStationId !== current.originStationId ||
          (
            admitted.replacesKeyId !== current.keyId &&
            admitted.keyId !== current.keyId
          )
        )
      ) {
        throw new Error("station browser pinned trust update is stale or discontinuous");
      }
      const path = await pinnedPath(admitted.generation);
      try {
        await atomicOwnerWrite(path, `${nextWire}\n`, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const winner = await readOwnerFile(path);
        if (
          winner === undefined ||
          canonicalStationBrowserJson(
            decodeStationBrowserPinnedTrustRecord(winner.trim()),
          ) !== nextWire
        ) {
          throw new Error("station browser pinned trust generation is already occupied");
        }
      }
      const latest = await readPinnedRecord();
      if (
        latest === undefined ||
        canonicalStationBrowserJson(latest) !== nextWire
      ) {
        throw new Error("station browser pinned trust update lost to a newer generation");
      }
      return latest;
    });

  const loadPinnedTrust = async (): Promise<StationBrowserTrust | undefined> => {
    const record = await readPinnedRecord();
    if (record === undefined || record.status === "revoked") return undefined;
    const publicKey = createPublicKey({
      key: decodeBase64(record.publicKeySpki),
      format: "der",
      type: "spki",
    });
    return Object.freeze({
      keyId: record.keyId,
      publicKey,
      originStationId: record.originStationId,
    });
  };

  return Object.freeze({
    loadOrCreateOriginKey,
    rotateOriginKey,
    readPinnedRecord,
    installPinnedRecord,
    loadPinnedTrust,
  });
};

export type StationBrowserTrustStore = ReturnType<
  typeof makeStationBrowserTrustStore
>;

export type StationBrowserTrustProvisionResponse = Readonly<{
  version: 1;
  ok: true;
  keyId: string;
  generation: number;
  status: "active" | "revoked";
}>;

const decodeProvisionResponse = (
  source: string,
): StationBrowserTrustProvisionResponse => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Remote station trust wrapper returned non-JSON");
  }
  if (
    !plain(value) ||
    !exactKeys(value, ["version", "ok", "keyId", "generation", "status"]) ||
    value.version !== 1 ||
    value.ok !== true ||
    !isStationBrowserKeyId(value.keyId) ||
    !safeInteger(value.generation) ||
    (value.status !== "active" && value.status !== "revoked")
  ) {
    throw new Error("Remote station trust wrapper returned a malformed response");
  }
  return value as unknown as StationBrowserTrustProvisionResponse;
};

export class StationBrowserTrustProvisionError extends Error {
  constructor(
    readonly code:
      | "unknown_host"
      | "host_capability"
      | "invalid_record"
      | "malformed_response",
    message: string,
  ) {
    super(message);
    this.name = "StationBrowserTrustProvisionError";
  }
}

/**
 * Typed configure/deploy hook. The registered Remote selects the endpoint;
 * variable trust material travels only through bounded stdin.
 */
export const provisionStationBrowserTrust = (
  ssh: typeof SshTransport.Service,
  hosts: ReadonlyArray<RemoteHost>,
  targetHostId: string,
  record: StationBrowserPinnedTrustRecord,
): Effect.Effect<
  StationBrowserTrustProvisionResponse,
  StationBrowserTrustProvisionError | SshError
> =>
  Effect.gen(function* () {
    let admitted: StationBrowserPinnedTrustRecord;
    try {
      admitted = decodePinnedRecordValue(record);
    } catch {
      return yield* Effect.fail(
        new StationBrowserTrustProvisionError(
          "invalid_record",
          "station browser trust record is invalid",
        ),
      );
    }
    const host = hosts.find((candidate) => candidate.id === targetHostId);
    if (
      host === undefined ||
      host.kind !== "remote" ||
      host.endpoint === undefined
    ) {
      return yield* Effect.fail(
        new StationBrowserTrustProvisionError(
          "unknown_host",
          "station browser trust target is not a configured Remote",
        ),
      );
    }
    if (!hostHasCapability(host, BROWSER_HOST_CAPABILITY)) {
      return yield* Effect.fail(
        new StationBrowserTrustProvisionError(
          "host_capability",
          "station browser trust target does not advertise browser capability",
        ),
      );
    }
    const endpoint = yield* parseSshEndpoint(host.endpoint).pipe(
      Effect.mapError(
        () =>
          new StationBrowserTrustProvisionError(
            "unknown_host",
            "station browser trust target has an invalid SSH endpoint",
          ),
      ),
    );
    const command = yield* remoteVellumBrowserStationTrust().pipe(
      Effect.mapError(
        () =>
          new StationBrowserTrustProvisionError(
            "invalid_record",
            "station browser trust wrapper policy is invalid",
          ),
      ),
    );
    const input = yield* makeRemoteStdin(
      canonicalStationBrowserJson(admitted),
    ).pipe(
      Effect.mapError(
        () =>
          new StationBrowserTrustProvisionError(
            "invalid_record",
            "station browser trust record exceeds the transport boundary",
          ),
      ),
    );
    const result = yield* ssh.run(
      oneShotWithStdin(endpoint, command, input, { budget: "standard" }),
    );
    let response: StationBrowserTrustProvisionResponse;
    try {
      response = decodeProvisionResponse(result.stdout.trim());
    } catch {
      return yield* Effect.fail(
        new StationBrowserTrustProvisionError(
          "malformed_response",
          "Remote station trust wrapper returned an invalid response",
        ),
      );
    }
    if (
      response.keyId !== admitted.keyId ||
      response.generation !== admitted.generation ||
      response.status !== admitted.status
    ) {
      return yield* Effect.fail(
        new StationBrowserTrustProvisionError(
          "malformed_response",
          "Remote station trust wrapper acknowledged different trust material",
        ),
      );
    }
    return response;
  });

/** Fixed-wrapper target entrypoint. It never accepts a path or program. */
export const installStationBrowserTrustFrame = async (
  frame: string,
  store = makeStationBrowserTrustStore(),
): Promise<string> => {
  const record = decodeStationBrowserPinnedTrustRecord(frame.trim());
  const installed = await store.installPinnedRecord(record);
  return canonicalStationBrowserJson({
    version: 1,
    ok: true,
    keyId: installed.keyId,
    generation: installed.generation,
    status: installed.status,
  } satisfies StationBrowserTrustProvisionResponse);
};
