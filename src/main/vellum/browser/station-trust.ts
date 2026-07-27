import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
import {
  canonicalStationBrowserJson,
  decodeStationBrowserPinnedTrustRecord,
  StationBrowserKeyId,
  StationBrowserTrustGeneration,
  STATION_BROWSER_TRUST_MAX_BYTES,
  STATION_BROWSER_TRUST_MAX_GENERATION,
  StationBrowserTrustTimestamp,
  type StationBrowserPinnedTrustRecord,
} from "@shared/station-browser";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "@shared/station-api";
import {
  StateEngine,
  type StateEngineError,
  type StateReader,
  type StateRow,
  type StateWriter,
} from "../state/service";
import type { StationBrowserTrust } from "./station-delegation";

export { STATION_BROWSER_TRUST_MAX_BYTES };

const decodeKeyId = Schema.decodeUnknownSync(StationBrowserKeyId);
const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeGeneration = Schema.decodeUnknownSync(
  StationBrowserTrustGeneration,
);
const decodeTimestamp = Schema.decodeUnknownSync(StationBrowserTrustTimestamp);

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

const decodeBase64 = (value: string): Buffer => Buffer.from(value, "base64");

const keyIdFor = (publicDer: Uint8Array): string =>
  `ed25519-${createHash("sha256")
    .update(publicDer)
    .digest("hex")
    .slice(0, 24)}`;

export class StationBrowserTrustError extends Schema.TaggedError<StationBrowserTrustError>()(
  "StationBrowserTrustError",
  {
    code: Schema.Literal(
      "invalid",
      "custody",
      "conflict",
      "stale",
      "discontinuous",
      "revoked",
      "exhausted",
      "corrupt",
      "persistence",
    ),
    operation: Schema.String,
    message: Schema.String,
  },
) {}

const trustError = (
  code: StationBrowserTrustError["code"],
  operation: string,
  message: string,
): StationBrowserTrustError =>
  StationBrowserTrustError.make({ code, operation, message });

const throwTrustError = (
  code: StationBrowserTrustError["code"],
  operation: string,
  message: string,
): never => {
  throw trustError(code, operation, message);
};

const fromStateError = (
  operation: string,
  error: StateEngineError,
): StationBrowserTrustError =>
  trustError("persistence", operation, error.message);

const attempt = <A>(
  operation: string,
  body: () => A,
): Effect.Effect<A, StationBrowserTrustError> =>
  Effect.try({
    try: body,
    catch: (cause) =>
      cause instanceof StationBrowserTrustError
        ? cause
        : trustError(
            "invalid",
            operation,
            cause instanceof Error ? cause.message : String(cause),
          ),
  });

type OriginKeyRecord = Readonly<{
  generation: number;
  keyId: string;
  originInstallationId: InstallationIdValue;
  createdAt: number;
  privateKeyPkcs8: Uint8Array;
  publicKeySpki: Uint8Array;
}>;

type OriginKeyRow = StateRow & {
  readonly generation: number;
  readonly key_id: string;
  readonly origin_installation_id: string;
  readonly created_at: number;
  readonly private_key_pkcs8: Uint8Array;
  readonly public_key_spki: Uint8Array;
};

type PinnedTrustRow = StateRow & {
  readonly generation: number;
  readonly key_id: string;
  readonly origin_installation_id: string;
  readonly status: string;
  readonly public_key_spki: Uint8Array | null;
  readonly replaces_key_id: string | null;
  readonly updated_at: number;
};

type AdmittedPinnedTrustRecord = Omit<
  StationBrowserPinnedTrustRecord,
  "originInstallationId"
> & Readonly<{
  originInstallationId: InstallationIdValue;
}>;

declare const originKeyBrand: unique symbol;
export interface StationBrowserOriginKey {
  readonly [originKeyBrand]: never;
  readonly generation: number;
  readonly keyId: string;
  readonly originInstallationId: InstallationIdValue;
  readonly createdAt: number;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

type OriginKeyCustody = Readonly<{
  custody: object;
  record: OriginKeyRecord;
}>;

const originKeys = new WeakMap<object, OriginKeyCustody>();

const bytesFromRow = (
  operation: string,
  field: string,
  value: unknown,
): Uint8Array => {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 16 ||
    value.byteLength > 1_024
  ) {
    return throwTrustError(
      "corrupt",
      operation,
      `${field} is not bounded binary key material`,
    );
  }
  return Uint8Array.from(value);
};

const originRecordFromRow = (row: OriginKeyRow): OriginKeyRecord => {
  const operation = "read-origin-key";
  let generation: number;
  let keyId: string;
  let originInstallationId: InstallationIdValue;
  let createdAt: number;
  try {
    generation = decodeGeneration(row.generation);
    keyId = decodeKeyId(row.key_id);
    originInstallationId = decodeInstallationId(
      row.origin_installation_id,
    );
    createdAt = decodeTimestamp(row.created_at);
  } catch {
    return throwTrustError(
      "corrupt",
      operation,
      "stored browser origin key metadata is malformed",
    );
  }
  return Object.freeze({
    generation,
    keyId,
    originInstallationId,
    createdAt,
    privateKeyPkcs8: bytesFromRow(
      operation,
      "private_key_pkcs8",
      row.private_key_pkcs8,
    ),
    publicKeySpki: bytesFromRow(
      operation,
      "public_key_spki",
      row.public_key_spki,
    ),
  });
};

const validateKeyPair = (
  operation: string,
  record: OriginKeyRecord,
): Readonly<{ privateKey: KeyObject; publicKey: KeyObject }> => {
  let privateKey: KeyObject;
  let publicKey: KeyObject;
  try {
    privateKey = createPrivateKey({
      key: Buffer.from(record.privateKeyPkcs8),
      format: "der",
      type: "pkcs8",
    });
    publicKey = createPublicKey({
      key: Buffer.from(record.publicKeySpki),
      format: "der",
      type: "spki",
    });
  } catch {
    return throwTrustError(
      "corrupt",
      operation,
      "stored browser origin key material is malformed",
    );
  }
  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519" ||
    publicKey.type !== "public" ||
    publicKey.asymmetricKeyType !== "ed25519"
  ) {
    return throwTrustError(
      "corrupt",
      operation,
      "browser origin key must be Ed25519",
    );
  }
  const derived = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  }) as Buffer;
  const supplied = publicKey.export({
    format: "der",
    type: "spki",
  }) as Buffer;
  if (!derived.equals(supplied) || record.keyId !== keyIdFor(supplied)) {
    return throwTrustError(
      "corrupt",
      operation,
      "browser origin key pair is inconsistent",
    );
  }
  return { privateKey, publicKey };
};

const materializeOriginKey = (
  custody: object,
  record: OriginKeyRecord,
): StationBrowserOriginKey => {
  const pair = validateKeyPair("materialize-origin-key", record);
  const key = Object.freeze({
    generation: record.generation,
    keyId: record.keyId,
    originInstallationId: record.originInstallationId,
    createdAt: record.createdAt,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  }) as StationBrowserOriginKey;
  originKeys.set(key, { custody, record });
  return key;
};

const createOriginRecord = (
  originInstallationId: InstallationIdValue,
  generation: number,
  createdAt: number,
): OriginKeyRecord => {
  const admittedOriginInstallationId =
    decodeInstallationId(originInstallationId);
  const admittedGeneration = decodeGeneration(generation);
  const admittedCreatedAt = decodeTimestamp(createdAt);
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPkcs8 = pair.privateKey.export({
    format: "der",
    type: "pkcs8",
  }) as Buffer;
  const publicKeySpki = pair.publicKey.export({
    format: "der",
    type: "spki",
  }) as Buffer;
  return Object.freeze({
    generation: admittedGeneration,
    keyId: decodeKeyId(keyIdFor(publicKeySpki)),
    originInstallationId: admittedOriginInstallationId,
    createdAt: admittedCreatedAt,
    privateKeyPkcs8: Uint8Array.from(privateKeyPkcs8),
    publicKeySpki: Uint8Array.from(publicKeySpki),
  });
};

const selectLatestOriginKey = (
  reader: StateReader,
): OriginKeyRecord | undefined => {
  const row = reader.get<OriginKeyRow>(
    `SELECT
       generation,
       key_id,
       origin_installation_id,
       created_at,
       private_key_pkcs8,
       public_key_spki
     FROM browser_origin_keys
     ORDER BY generation DESC
     LIMIT 1`,
  );
  return row === undefined ? undefined : originRecordFromRow(row);
};

const insertOriginKey = (
  writer: StateWriter,
  record: OriginKeyRecord,
): void => {
  writer.run(
    `INSERT INTO browser_origin_keys(
       generation,
       key_id,
       origin_installation_id,
       created_at,
       private_key_pkcs8,
       public_key_spki
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      record.generation,
      record.keyId,
      record.originInstallationId,
      record.createdAt,
      record.privateKeyPkcs8,
      record.publicKeySpki,
    ],
  );
};

const sameOriginRecord = (
  left: OriginKeyRecord,
  right: OriginKeyRecord,
): boolean =>
  left.generation === right.generation &&
  left.keyId === right.keyId &&
  left.originInstallationId === right.originInstallationId &&
  left.createdAt === right.createdAt &&
  Buffer.from(left.privateKeyPkcs8).equals(
    Buffer.from(right.privateKeyPkcs8),
  ) &&
  Buffer.from(left.publicKeySpki).equals(Buffer.from(right.publicKeySpki));

const admitPinnedRecord = (value: unknown): AdmittedPinnedTrustRecord => {
  let record: StationBrowserPinnedTrustRecord;
  let originInstallationId: InstallationIdValue;
  try {
    record = decodeStationBrowserPinnedTrustRecord(value);
    originInstallationId = decodeInstallationId(
      record.originInstallationId,
    );
  } catch {
    return throwTrustError(
      "invalid",
      "admit-pinned-trust",
      "browser pinned trust record is malformed",
    );
  }
  if (record.status === "active") {
    let publicKey: KeyObject;
    const publicDer = decodeBase64(record.publicKeySpki!);
    try {
      publicKey = createPublicKey({
        key: publicDer,
        format: "der",
        type: "spki",
      });
    } catch {
      return throwTrustError(
        "invalid",
        "admit-pinned-trust",
        "browser pinned trust public key is malformed",
      );
    }
    if (
      publicKey.type !== "public" ||
      publicKey.asymmetricKeyType !== "ed25519" ||
      record.keyId !== keyIdFor(publicDer)
    ) {
      return throwTrustError(
        "invalid",
        "admit-pinned-trust",
        "browser pinned trust must contain its exact Ed25519 public key",
      );
    }
  }
  return Object.freeze({
    ...record,
    originInstallationId,
  });
};

export const decodeStationBrowserPinnedTrustFrame = (
  frame: string,
): StationBrowserPinnedTrustRecord => {
  if (Buffer.byteLength(frame, "utf8") > STATION_BROWSER_TRUST_MAX_BYTES) {
    return throwTrustError(
      "invalid",
      "decode-pinned-trust-frame",
      "browser pinned trust frame exceeds its byte boundary",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return throwTrustError(
      "invalid",
      "decode-pinned-trust-frame",
      "browser pinned trust frame is not JSON",
    );
  }
  const record = admitPinnedRecord(value);
  if (canonicalStationBrowserJson(record) !== frame.trim()) {
    return throwTrustError(
      "invalid",
      "decode-pinned-trust-frame",
      "browser pinned trust frame is not canonical",
    );
  }
  return record;
};

const pinnedRecordFromRow = (
  row: PinnedTrustRow,
): AdmittedPinnedTrustRecord =>
  admitPinnedRecord({
    version: 1,
    generation: row.generation,
    keyId: row.key_id,
    originInstallationId: row.origin_installation_id,
    status: row.status,
    publicKeySpki:
      row.public_key_spki === null
        ? null
        : base64(
            bytesFromRow(
              "read-pinned-trust",
              "public_key_spki",
              row.public_key_spki,
            ),
          ),
    replacesKeyId: row.replaces_key_id,
    updatedAt: row.updated_at,
  });

const selectLatestPinnedRecord = (
  reader: StateReader,
): AdmittedPinnedTrustRecord | undefined => {
  const row = reader.get<PinnedTrustRow>(
    `SELECT
       generation,
       key_id,
       origin_installation_id,
       status,
       public_key_spki,
       replaces_key_id,
       updated_at
     FROM browser_pinned_origin_trust
     ORDER BY generation DESC
     LIMIT 1`,
  );
  return row === undefined ? undefined : pinnedRecordFromRow(row);
};

const insertPinnedRecord = (
  writer: StateWriter,
  record: AdmittedPinnedTrustRecord,
): void => {
  writer.run(
    `INSERT INTO browser_pinned_origin_trust(
       generation,
       key_id,
       origin_installation_id,
       status,
       public_key_spki,
       replaces_key_id,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      record.generation,
      record.keyId,
      record.originInstallationId,
      record.status,
      record.publicKeySpki === null ? null : decodeBase64(record.publicKeySpki),
      record.replacesKeyId,
      record.updatedAt,
    ],
  );
};

/**
 * Apply a public trust transition inside an existing StateEngine transaction.
 *
 * Station configure calls this component in the same transaction that installs
 * its topology, so a Remote can never expose new reach with an old browser pin.
 */
export const installStationBrowserPinnedRecord = (
  writer: StateWriter,
  next: StationBrowserPinnedTrustRecord,
): StationBrowserPinnedTrustRecord => {
  const admitted = admitPinnedRecord(next);
  const current = selectLatestPinnedRecord(writer);
  const nextWire = canonicalStationBrowserJson(admitted);
  if (current !== undefined && admitted.generation === current.generation) {
    if (nextWire === canonicalStationBrowserJson(current)) return current;
    return throwTrustError(
      "conflict",
      "install-pinned-trust",
      "browser pinned trust generation is already occupied",
    );
  }
  if (current !== undefined && admitted.generation < current.generation) {
    return throwTrustError(
      "stale",
      "install-pinned-trust",
      "browser pinned trust update is stale",
    );
  }
  if (current?.status === "revoked") {
    return throwTrustError(
      "revoked",
      "install-pinned-trust",
      "browser pinned trust revocation is irreversible",
    );
  }
  if (
    current !== undefined &&
    admitted.originInstallationId !== current.originInstallationId
  ) {
    return throwTrustError(
      "discontinuous",
      "install-pinned-trust",
      "browser pinned trust origin changed",
    );
  }
  if (
    current !== undefined &&
    ((admitted.status === "active" &&
      (admitted.keyId === current.keyId ||
        admitted.replacesKeyId !== current.keyId)) ||
      (admitted.status === "revoked" &&
        (admitted.keyId !== current.keyId ||
          admitted.replacesKeyId !== current.keyId)))
  ) {
    return throwTrustError(
      "discontinuous",
      "install-pinned-trust",
      "browser pinned trust replacement is discontinuous",
    );
  }
  insertPinnedRecord(writer, admitted);
  return admitted;
};

export const pinnedTrustForOriginKey = (
  key: StationBrowserOriginKey,
  replacesKeyId: string | null = null,
  updatedAt = Date.now(),
): StationBrowserPinnedTrustRecord => {
  const state = originKeys.get(key);
  if (state === undefined) {
    return throwTrustError(
      "custody",
      "project-pinned-trust",
      "browser trust requires a custody-owned origin key",
    );
  }
  return admitPinnedRecord({
    version: 1,
    generation: key.generation,
    keyId: key.keyId,
    originInstallationId: key.originInstallationId,
    status: "active",
    publicKeySpki: base64(state.record.publicKeySpki),
    replacesKeyId,
    updatedAt,
  });
};

export const revokePinnedTrust = (
  current: StationBrowserPinnedTrustRecord,
  updatedAt = Date.now(),
): StationBrowserPinnedTrustRecord => {
  const admitted = admitPinnedRecord(current);
  if (admitted.status !== "active") {
    return throwTrustError(
      "revoked",
      "revoke-pinned-trust",
      "only active browser trust can be revoked",
    );
  }
  if (admitted.generation >= STATION_BROWSER_TRUST_MAX_GENERATION) {
    return throwTrustError(
      "exhausted",
      "revoke-pinned-trust",
      "browser pinned trust generation is exhausted",
    );
  }
  return admitPinnedRecord({
    version: 1,
    generation: admitted.generation + 1,
    keyId: admitted.keyId,
    originInstallationId: admitted.originInstallationId,
    status: "revoked",
    publicKeySpki: null,
    replacesKeyId: admitted.keyId,
    updatedAt,
  });
};

export class StationBrowserTrustRepository extends Context.Tag(
  "@vellum/StationBrowserTrustRepository",
)<
  StationBrowserTrustRepository,
  {
    readonly loadOrCreateOriginKey: (
      originInstallationId: InstallationIdValue,
      now?: number,
    ) => Effect.Effect<StationBrowserOriginKey, StationBrowserTrustError>;
    readonly rotateOriginKey: (
      current: StationBrowserOriginKey,
      now?: number,
    ) => Effect.Effect<StationBrowserOriginKey, StationBrowserTrustError>;
    readonly readPinnedRecord: Effect.Effect<
      StationBrowserPinnedTrustRecord | undefined,
      StationBrowserTrustError
    >;
    readonly installPinnedRecord: (
      next: StationBrowserPinnedTrustRecord,
    ) => Effect.Effect<
      StationBrowserPinnedTrustRecord,
      StationBrowserTrustError
    >;
    readonly loadPinnedTrust: Effect.Effect<
      StationBrowserTrust | undefined,
      StationBrowserTrustError
    >;
  }
>() {}

export const makeStationBrowserTrustRepositoryLive = (): Layer.Layer<
  StationBrowserTrustRepository,
  never,
  StateEngine
> =>
  Layer.effect(
    StationBrowserTrustRepository,
    Effect.gen(function* () {
      const engine = yield* StateEngine;
      const custody = Object.freeze({});

      const loadOrCreateOriginKey = Effect.fn(
        "StationBrowserTrustRepository.loadOrCreateOriginKey",
      )(function* (
        originInstallationId: InstallationIdValue,
        now = Date.now(),
      ) {
        const admittedOriginInstallationId = yield* attempt(
          "load-or-create-origin-key",
          () => decodeInstallationId(originInstallationId),
        );
        const admittedNow = yield* attempt("load-or-create-origin-key", () =>
          decodeTimestamp(now),
        );
        const record = yield* engine
          .transaction("browser-trust.load-or-create-origin-key", (writer) => {
            const current = selectLatestOriginKey(writer);
            if (current !== undefined) {
              if (
                current.originInstallationId !==
                  admittedOriginInstallationId
              ) {
                return throwTrustError(
                  "custody",
                  "load-or-create-origin-key",
                  "browser origin key is pinned to another installation",
                );
              }
              return current;
            }
            const created = createOriginRecord(
              admittedOriginInstallationId,
              1,
              admittedNow,
            );
            insertOriginKey(writer, created);
            return created;
          })
          .pipe(
            Effect.mapError((error) =>
              fromStateError("load-or-create-origin-key", error),
            ),
          );
        return yield* attempt("load-or-create-origin-key", () =>
          materializeOriginKey(custody, record),
        );
      });

      const rotateOriginKey = Effect.fn(
        "StationBrowserTrustRepository.rotateOriginKey",
      )(function* (current: StationBrowserOriginKey, now = Date.now()) {
        const held = originKeys.get(current);
        if (held === undefined || held.custody !== custody) {
          return yield* trustError(
            "custody",
            "rotate-origin-key",
            "browser origin-key rotation requires current repository custody",
          );
        }
        const admittedNow = yield* attempt("rotate-origin-key", () =>
          decodeTimestamp(now),
        );
        const next = yield* engine
          .transaction("browser-trust.rotate-origin-key", (writer) => {
            const persisted = selectLatestOriginKey(writer);
            if (
              persisted === undefined ||
              !sameOriginRecord(persisted, held.record)
            ) {
              return throwTrustError(
                "stale",
                "rotate-origin-key",
                "browser origin key changed before rotation",
              );
            }
            if (persisted.generation >= STATION_BROWSER_TRUST_MAX_GENERATION) {
              return throwTrustError(
                "exhausted",
                "rotate-origin-key",
                "browser origin key generation is exhausted",
              );
            }
            const created = createOriginRecord(
              persisted.originInstallationId,
              persisted.generation + 1,
              admittedNow,
            );
            insertOriginKey(writer, created);
            return created;
          })
          .pipe(
            Effect.mapError((error) =>
              fromStateError("rotate-origin-key", error),
            ),
          );
        return yield* attempt("rotate-origin-key", () =>
          materializeOriginKey(custody, next),
        );
      });

      const readPinnedRecord = engine
        .read("browser-trust.read-pinned-record", selectLatestPinnedRecord)
        .pipe(
          Effect.mapError((error) =>
            fromStateError("read-pinned-record", error),
          ),
          Effect.withSpan(
            "station-browser-trust-repository.read-pinned-record",
          ),
        );

      const installPinnedRecord = Effect.fn(
        "StationBrowserTrustRepository.installPinnedRecord",
      )((next: StationBrowserPinnedTrustRecord) =>
        engine
          .transaction("browser-trust.install-pinned-record", (writer) =>
            installStationBrowserPinnedRecord(writer, next),
          )
          .pipe(
            Effect.mapError((error) =>
              fromStateError("install-pinned-record", error),
            ),
          ),
      );

      const loadPinnedTrust = readPinnedRecord.pipe(
        Effect.flatMap((record) => {
          if (record === undefined || record.status === "revoked") {
            return Effect.succeed(undefined);
          }
          return attempt("load-pinned-trust", () => {
            const publicKey = createPublicKey({
              key: decodeBase64(record.publicKeySpki!),
              format: "der",
              type: "spki",
            });
            return Object.freeze({
              keyId: record.keyId,
              publicKey,
              originInstallationId: record.originInstallationId,
            });
          });
        }),
        Effect.withSpan("station-browser-trust-repository.load-pinned-trust"),
      );

      return StationBrowserTrustRepository.of({
        loadOrCreateOriginKey,
        rotateOriginKey,
        readPinnedRecord,
        installPinnedRecord,
        loadPinnedTrust,
      });
    }),
  );

export const StationBrowserTrustRepositoryLive =
  makeStationBrowserTrustRepositoryLive();
