import { randomBytes } from "node:crypto";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  ContentAvailability,
  ContentAvailabilityReason,
  ContentByteLength,
  ContentDisplayName,
  ContentMediaType,
  ContentRef,
  ContentSha256,
  ContentTimestamp,
} from "@shared/content";
import type { StateReader, StateWriter } from "../state/service";

export type ContentOwnerKind =
  | "task"
  | "message"
  | "artifact"
  | "board_topic"
  | "board_post"
  | "other";

export type ContentOwner = {
  readonly kind: ContentOwnerKind;
  readonly canvasName: string;
  readonly nodeId: string;
  readonly recordId: string;
};

export type ContentObjectRow = {
  readonly sha256: string;
  readonly byteLength: number;
  readonly createdAt: string;
  readonly verifiedAt: string;
};

export type ContentRefRow = {
  readonly refId: string;
  readonly ref: ContentRef;
  readonly owner: ContentOwner;
  readonly createdAt: string;
};

export type ContentTransferState =
  | "pending"
  | "receiving"
  | "verifying"
  | "complete"
  | "failed"
  | "canceled";

export type ContentTransferDirection = "inbound" | "outbound";

export type ContentTransferRow = {
  readonly transferId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly state: ContentTransferState;
  readonly direction: ContentTransferDirection;
  readonly peerInstallationId?: string;
  readonly errorReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export class ContentManifestError extends Error {
  readonly _tag = "ContentManifestError";
  readonly code: "missing" | "conflict" | "invalid" | "order" | "sql" | "decode";

  constructor(
    code: ContentManifestError["code"],
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "ContentManifestError";
    this.code = code;
  }
}

const asRef = (row: {
  readonly sha256: string;
  readonly byte_length: number | bigint;
  readonly media_type: string;
  readonly display_name: string | null;
}): ContentRef => {
  const ref: ContentRef = {
    sha256: row.sha256 as ContentSha256,
    byteLength: Number(row.byte_length) as ContentByteLength,
    mediaType: row.media_type as ContentMediaType,
  };
  if (row.display_name !== null) {
    return {
      ...ref,
      displayName: row.display_name as ContentRef["displayName"],
    };
  }
  return ref;
};

/**
 * Record a verified object in the manifest.  Idempotent on matching identity.
 * Must only be called after the object file is durable on disk.
 */
export const recordContentObject = (
  writer: StateWriter,
  input: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly verifiedAt: string;
    readonly createdAt?: string;
  },
): { readonly created: boolean } => {
  if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
    throw new ContentManifestError("invalid", "sha256 must be lower-case hex");
  }
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
    throw new ContentManifestError("invalid", "byteLength must be a safe integer");
  }

  const existing = writer.get<{
    readonly sha256: string;
    readonly byte_length: number | bigint;
  }>(
    `SELECT sha256, byte_length FROM content_objects WHERE sha256 = ?`,
    [input.sha256],
  );
  if (existing !== undefined) {
    if (Number(existing.byte_length) !== input.byteLength) {
      throw new ContentManifestError(
        "conflict",
        `content object ${input.sha256} already exists with a different length`,
      );
    }
    // Refresh receipt verified_at for re-admission of the same digest.
    writer.run(
      `
        INSERT INTO content_receipts(
          sha256, verified_sha256, verified_byte_length, verified_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(sha256) DO UPDATE SET
          verified_sha256 = excluded.verified_sha256,
          verified_byte_length = excluded.verified_byte_length,
          verified_at = excluded.verified_at
      `,
      [input.sha256, input.sha256, input.byteLength, input.verifiedAt],
    );
    return { created: false };
  }

  const createdAt = input.createdAt ?? input.verifiedAt;
  writer.run(
    `
      INSERT INTO content_objects(sha256, byte_length, created_at, verified_at)
      VALUES (?, ?, ?, ?)
    `,
    [input.sha256, input.byteLength, createdAt, input.verifiedAt],
  );
  writer.run(
    `
      INSERT INTO content_receipts(
        sha256, verified_sha256, verified_byte_length, verified_at
      ) VALUES (?, ?, ?, ?)
    `,
    [input.sha256, input.sha256, input.byteLength, input.verifiedAt],
  );
  return { created: true };
};

/**
 * Bind a ContentRef to an owner after the object row exists.
 * Fails closed if the object is not in the manifest (no dangling refs).
 */
export const recordContentRef = (
  writer: StateWriter,
  input: {
    readonly ref: ContentRef;
    readonly owner: ContentOwner;
    readonly refId?: string;
    readonly createdAt?: string;
  },
): ContentRefRow => {
  const object = writer.get<{
    readonly sha256: string;
    readonly byte_length: number | bigint;
  }>(
    `SELECT sha256, byte_length FROM content_objects WHERE sha256 = ?`,
    [input.ref.sha256],
  );
  if (object === undefined) {
    throw new ContentManifestError(
      "order",
      "content ref requires a durable content_objects row first",
    );
  }
  if (Number(object.byte_length) !== input.ref.byteLength) {
    throw new ContentManifestError(
      "conflict",
      "content ref byteLength does not match content_objects",
    );
  }

  const refId = input.refId ?? `cref_${randomBytes(16).toString("hex")}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  writer.run(
    `
      INSERT INTO content_refs(
        ref_id,
        sha256,
        byte_length,
        media_type,
        display_name,
        owner_kind,
        owner_canvas,
        owner_node,
        owner_record_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      refId,
      input.ref.sha256,
      input.ref.byteLength,
      input.ref.mediaType,
      input.ref.displayName ?? null,
      input.owner.kind,
      input.owner.canvasName,
      input.owner.nodeId,
      input.owner.recordId,
      createdAt,
    ],
  );

  return {
    refId,
    ref: input.ref,
    owner: input.owner,
    createdAt,
  };
};

export const getContentObject = (
  reader: StateReader,
  sha256: string,
): ContentObjectRow | undefined => {
  const row = reader.get<{
    readonly sha256: string;
    readonly byte_length: number | bigint;
    readonly created_at: string;
    readonly verified_at: string;
  }>(
    `
      SELECT sha256, byte_length, created_at, verified_at
      FROM content_objects
      WHERE sha256 = ?
    `,
    [sha256],
  );
  if (row === undefined) return undefined;
  return {
    sha256: row.sha256,
    byteLength: Number(row.byte_length),
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
};

/**
 * Let go of every reference one owner holds. The objects stay until garbage
 * collection finds nothing else referencing them and their grace has passed.
 * Returns how many references were released.
 */
export const releaseContentRefsForOwner = (
  writer: StateWriter,
  owner: ContentOwner,
): number => {
  const held = writer.get<{ readonly count: number | bigint }>(
    `
      SELECT COUNT(*) AS count FROM content_refs
      WHERE owner_canvas = ? AND owner_node = ? AND owner_kind = ? AND owner_record_id = ?
    `,
    [owner.canvasName, owner.nodeId, owner.kind, owner.recordId],
  );
  writer.run(
    `
      DELETE FROM content_refs
      WHERE owner_canvas = ? AND owner_node = ? AND owner_kind = ? AND owner_record_id = ?
    `,
    [owner.canvasName, owner.nodeId, owner.kind, owner.recordId],
  );
  return Number(held?.count ?? 0);
};

export const listContentRefsForObject = (
  reader: StateReader,
  sha256: string,
): ReadonlyArray<ContentRefRow> => {
  const rows = reader.all<{
    readonly ref_id: string;
    readonly sha256: string;
    readonly byte_length: number | bigint;
    readonly media_type: string;
    readonly display_name: string | null;
    readonly owner_kind: ContentOwnerKind;
    readonly owner_canvas: string;
    readonly owner_node: string;
    readonly owner_record_id: string;
    readonly created_at: string;
  }>(
    `
      SELECT
        ref_id, sha256, byte_length, media_type, display_name,
        owner_kind, owner_canvas, owner_node, owner_record_id, created_at
      FROM content_refs
      WHERE sha256 = ?
      ORDER BY created_at, ref_id
    `,
    [sha256],
  );
  return rows.map((row) => ({
    refId: row.ref_id,
    ref: asRef(row),
    owner: {
      kind: row.owner_kind,
      canvasName: row.owner_canvas,
      nodeId: row.owner_node,
      recordId: row.owner_record_id,
    },
    createdAt: row.created_at,
  }));
};

/**
 * Manifest-side availability: object row + receipt.  Callers combine with
 * filesystem verification for the full fail-closed ContentAvailability.
 */
export const manifestAvailability = (
  reader: StateReader,
  ref: ContentRef,
): ContentAvailability => {
  const object = getContentObject(reader, ref.sha256);
  if (object === undefined) {
    return {
      ref,
      state: "missing",
      reason: "content object is not in the local manifest" as ContentAvailabilityReason,
    };
  }
  if (object.byteLength !== ref.byteLength) {
    return {
      ref,
      state: "corrupt",
      reason: "manifest byte_length does not match ContentRef" as ContentAvailabilityReason,
      observedByteLength: object.byteLength as ContentByteLength,
    };
  }
  const receipt = reader.get<{
    readonly verified_sha256: string;
    readonly verified_byte_length: number | bigint;
    readonly verified_at: string;
  }>(
    `
      SELECT verified_sha256, verified_byte_length, verified_at
      FROM content_receipts
      WHERE sha256 = ?
    `,
    [ref.sha256],
  );
  if (receipt === undefined) {
    return {
      ref,
      state: "unavailable",
      reason: "content object has no verification receipt" as ContentAvailabilityReason,
    };
  }
  if (
    receipt.verified_sha256 !== ref.sha256 ||
    Number(receipt.verified_byte_length) !== ref.byteLength
  ) {
    return {
      ref,
      state: "corrupt",
      reason: "content receipt does not match ContentRef" as ContentAvailabilityReason,
      observedSha256: receipt.verified_sha256 as ContentSha256,
      observedByteLength: Number(
        receipt.verified_byte_length,
      ) as ContentByteLength,
    };
  }
  return {
    ref,
    state: "verified",
    verifiedSha256: receipt.verified_sha256 as ContentSha256,
    verifiedByteLength: Number(
      receipt.verified_byte_length,
    ) as ContentByteLength,
    verifiedAt: receipt.verified_at as ContentTimestamp,
  };
};

/** Every distinct digest bound by a content_refs row (mark set for GC). */
export const listReferencedContentDigests = (
  reader: StateReader,
): ReadonlyArray<{ readonly sha256: string; readonly byteLength: number }> => {
  const rows = reader.all<{
    readonly sha256: string;
    readonly byte_length: number | bigint;
  }>(
    `
      SELECT DISTINCT sha256, byte_length
      FROM content_refs
      ORDER BY sha256
    `,
  );
  return rows.map((row) => ({
    sha256: row.sha256,
    byteLength: Number(row.byte_length),
  }));
};

/** Digests protected by an in-flight transfer (not complete/failed/canceled). */
export const listActiveTransferDigests = (
  reader: StateReader,
): ReadonlyArray<{
  readonly sha256: string;
  readonly byteLength: number;
  readonly transferId: string;
  readonly state: ContentTransferState;
}> => {
  const rows = reader.all<{
    readonly transfer_id: string;
    readonly sha256: string;
    readonly byte_length: number | bigint;
    readonly state: ContentTransferState;
  }>(
    `
      SELECT transfer_id, sha256, byte_length, state
      FROM content_transfers
      WHERE state IN ('pending', 'receiving', 'verifying')
      ORDER BY sha256, transfer_id
    `,
  );
  return rows.map((row) => ({
    transferId: row.transfer_id,
    sha256: row.sha256,
    byteLength: Number(row.byte_length),
    state: row.state,
  }));
};

export type ContentObjectAgeRow = {
  readonly sha256: string;
  readonly byteLength: number;
  readonly createdAt: string;
  readonly verifiedAt: string;
  readonly refCount: number;
};

/** Manifest objects with ref counts — used by integrity/GC. */
export const listContentObjectsWithRefCounts = (
  reader: StateReader,
): ReadonlyArray<ContentObjectAgeRow> => {
  const rows = reader.all<{
    readonly sha256: string;
    readonly byte_length: number | bigint;
    readonly created_at: string;
    readonly verified_at: string;
    readonly ref_count: number | bigint;
  }>(
    `
      SELECT
        o.sha256,
        o.byte_length,
        o.created_at,
        o.verified_at,
        (
          SELECT count(*)
          FROM content_refs r
          WHERE r.sha256 = o.sha256
        ) AS ref_count
      FROM content_objects o
      ORDER BY o.created_at, o.sha256
    `,
  );
  return rows.map((row) => ({
    sha256: row.sha256,
    byteLength: Number(row.byte_length),
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    refCount: Number(row.ref_count),
  }));
};

/**
 * Remove an unreferenced content object and its receipt from the manifest.
 * Fails closed if any content_refs still point at the digest (GC must re-check).
 */
export const deleteUnreferencedContentObject = (
  writer: StateWriter,
  sha256: string,
): { readonly deleted: boolean } => {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new ContentManifestError("invalid", "sha256 must be lower-case hex");
  }
  const refs = writer.get<{ readonly count: number | bigint }>(
    `SELECT count(*) AS count FROM content_refs WHERE sha256 = ?`,
    [sha256],
  );
  if (Number(refs?.count ?? 0) > 0) {
    throw new ContentManifestError(
      "conflict",
      `cannot GC content object ${sha256}: still referenced`,
    );
  }
  const active = writer.get<{ readonly count: number | bigint }>(
    `
      SELECT count(*) AS count
      FROM content_transfers
      WHERE sha256 = ?
        AND state IN ('pending', 'receiving', 'verifying')
    `,
    [sha256],
  );
  if (Number(active?.count ?? 0) > 0) {
    throw new ContentManifestError(
      "conflict",
      `cannot GC content object ${sha256}: transfer still active`,
    );
  }
  const object = writer.get<{ readonly sha256: string }>(
    `SELECT sha256 FROM content_objects WHERE sha256 = ?`,
    [sha256],
  );
  if (object === undefined) return { deleted: false };
  writer.run(`DELETE FROM content_receipts WHERE sha256 = ?`, [sha256]);
  writer.run(`DELETE FROM content_objects WHERE sha256 = ?`, [sha256]);
  return { deleted: true };
};

export const upsertContentTransfer = (
  writer: StateWriter,
  input: {
    readonly transferId?: string;
    readonly sha256: string;
    readonly byteLength: number;
    readonly state: ContentTransferState;
    readonly direction: ContentTransferDirection;
    readonly peerInstallationId?: string;
    readonly errorReason?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
  },
): ContentTransferRow => {
  const transferId =
    input.transferId ?? `xfer_${randomBytes(16).toString("hex")}`;
  const now = new Date().toISOString();
  const createdAt = input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? now;

  const existing = writer.get<{ readonly transfer_id: string }>(
    `SELECT transfer_id FROM content_transfers WHERE transfer_id = ?`,
    [transferId],
  );
  if (existing === undefined) {
    writer.run(
      `
        INSERT INTO content_transfers(
          transfer_id, sha256, byte_length, state, direction,
          peer_installation_id, error_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        transferId,
        input.sha256,
        input.byteLength,
        input.state,
        input.direction,
        input.peerInstallationId ?? null,
        input.errorReason ?? null,
        createdAt,
        updatedAt,
      ],
    );
  } else {
    writer.run(
      `
        UPDATE content_transfers
        SET
          sha256 = ?,
          byte_length = ?,
          state = ?,
          direction = ?,
          peer_installation_id = ?,
          error_reason = ?,
          updated_at = ?
        WHERE transfer_id = ?
      `,
      [
        input.sha256,
        input.byteLength,
        input.state,
        input.direction,
        input.peerInstallationId ?? null,
        input.errorReason ?? null,
        updatedAt,
        transferId,
      ],
    );
  }

  return {
    transferId,
    sha256: input.sha256,
    byteLength: input.byteLength,
    state: input.state,
    direction: input.direction,
    peerInstallationId: input.peerInstallationId,
    errorReason: input.errorReason,
    createdAt,
    updatedAt,
  };
};

export type ContentManifestShape = {
  readonly recordContentObject: (input: Parameters<typeof recordContentObject>[1]) => Effect.Effect<{ readonly created: boolean }, ContentManifestError>;
  readonly recordContentRef: (input: Parameters<typeof recordContentRef>[1]) => Effect.Effect<ContentRefRow, ContentManifestError>;
  readonly getContentObject: (sha256: string) => Effect.Effect<ContentObjectRow | undefined, ContentManifestError>;
  readonly listContentRefsForObject: (sha256: string) => Effect.Effect<ReadonlyArray<ContentRefRow>, ContentManifestError>;
  readonly manifestAvailability: (ref: ContentRef) => Effect.Effect<ContentAvailability, ContentManifestError>;
  readonly listReferencedContentDigests: () => Effect.Effect<ReturnType<typeof listReferencedContentDigests>, ContentManifestError>;
  readonly listActiveTransferDigests: () => Effect.Effect<ReturnType<typeof listActiveTransferDigests>, ContentManifestError>;
  readonly listContentObjectsWithRefCounts: () => Effect.Effect<ReadonlyArray<ContentObjectAgeRow>, ContentManifestError>;
  readonly deleteUnreferencedContentObject: (sha256: string) => Effect.Effect<{ readonly deleted: boolean }, ContentManifestError>;
  readonly upsertContentTransfer: (input: Parameters<typeof upsertContentTransfer>[1]) => Effect.Effect<ContentTransferRow, ContentManifestError>;
};

const ObjectRow = Schema.Struct({
  sha256: ContentSha256,
  byteLength: ContentByteLength,
  createdAt: ContentTimestamp,
  verifiedAt: ContentTimestamp,
});
const IdentityRow = Schema.Struct({ sha256: ContentSha256, byteLength: ContentByteLength });
const RefRow = Schema.Struct({
  refId: Schema.String,
  ...IdentityRow.fields,
  mediaType: ContentMediaType,
  displayName: Schema.NullOr(ContentDisplayName),
  ownerKind: Schema.Literals(["task", "message", "artifact", "board_topic", "board_post", "other"]),
  ownerCanvas: Schema.String,
  ownerNode: Schema.String,
  ownerRecordId: Schema.String,
  createdAt: ContentTimestamp,
});
const ReceiptRow = Schema.Struct({
  verifiedSha256: ContentSha256,
  verifiedByteLength: ContentByteLength,
  verifiedAt: ContentTimestamp,
});
const ActiveTransferRow = Schema.Struct({
  ...IdentityRow.fields,
  transferId: Schema.String,
  state: Schema.Literals(["pending", "receiving", "verifying"]),
});
const ObjectAgeRow = Schema.Struct({ ...ObjectRow.fields, refCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) });

const manifestError = (cause: unknown): ContentManifestError => {
  if (cause instanceof ContentManifestError) return cause;
  return new ContentManifestError(
    Schema.isSchemaError(cause) ? "decode" : "sql",
    cause instanceof Error ? cause.message : String(cause),
    { cause },
  );
};

/** SQL-only ledger capability. Methods join the caller's transaction context. */
export class ContentManifest extends Context.Service<ContentManifest, ContentManifestShape>()("@junto/ContentManifest") {
  static readonly layer = Layer.effect(this, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const getObject = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ObjectRow,
      execute: (sha256) => sql`SELECT sha256, byte_length AS byteLength,
        created_at AS createdAt, verified_at AS verifiedAt FROM content_objects WHERE sha256 = ${sha256}`,
    });
    const getReceipt = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ReceiptRow,
      execute: (sha256) => sql`SELECT verified_sha256 AS verifiedSha256,
        verified_byte_length AS verifiedByteLength, verified_at AS verifiedAt
        FROM content_receipts WHERE sha256 = ${sha256}`,
    });
    const refs = SqlSchema.findAll({
      Request: Schema.String,
      Result: RefRow,
      execute: (sha256) => sql`SELECT ref_id AS refId, sha256, byte_length AS byteLength,
        media_type AS mediaType, display_name AS displayName, owner_kind AS ownerKind,
        owner_canvas AS ownerCanvas, owner_node AS ownerNode, owner_record_id AS ownerRecordId,
        created_at AS createdAt FROM content_refs WHERE sha256 = ${sha256} ORDER BY created_at, ref_id`,
    });
    const referenced = SqlSchema.findAll({
      Request: Schema.Void,
      Result: IdentityRow,
      execute: () => sql`SELECT DISTINCT sha256, byte_length AS byteLength FROM content_refs ORDER BY sha256`,
    });
    const active = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ActiveTransferRow,
      execute: () => sql`SELECT transfer_id AS transferId, sha256, byte_length AS byteLength, state
        FROM content_transfers WHERE state IN ('pending', 'receiving', 'verifying') ORDER BY sha256, transfer_id`,
    });
    const objects = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ObjectAgeRow,
      execute: () => sql`SELECT o.sha256, o.byte_length AS byteLength, o.created_at AS createdAt,
        o.verified_at AS verifiedAt, (SELECT count(*) FROM content_refs r WHERE r.sha256 = o.sha256) AS refCount
        FROM content_objects o ORDER BY o.created_at, o.sha256`,
    });
    const protectedObject = SqlSchema.findOne({
      Request: Schema.String,
      Result: Schema.Struct({ refs: Schema.Int, active: Schema.Int }),
      execute: (sha256) => sql`SELECT
        (SELECT count(*) FROM content_refs WHERE sha256 = ${sha256}) AS refs,
        (SELECT count(*) FROM content_transfers WHERE sha256 = ${sha256}
          AND state IN ('pending', 'receiving', 'verifying')) AS active`,
    });

    return ContentManifest.of({
      recordContentObject: Effect.fn("ContentManifest.recordContentObject")(function* (input) {
        if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
          return yield* Effect.fail(new ContentManifestError("invalid", "sha256 must be lower-case hex"));
        }
        if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
          return yield* Effect.fail(new ContentManifestError("invalid", "byteLength must be a safe integer"));
        }
        const existing = yield* getObject(input.sha256);
        if (Option.isSome(existing) && existing.value.byteLength !== input.byteLength) {
          return yield* Effect.fail(new ContentManifestError("conflict", `content object ${input.sha256} already exists with a different length`));
        }
        if (Option.isNone(existing)) {
          yield* sql`INSERT INTO content_objects(sha256, byte_length, created_at, verified_at)
            VALUES (${input.sha256}, ${input.byteLength}, ${input.createdAt ?? input.verifiedAt}, ${input.verifiedAt})`;
        }
        yield* sql`INSERT INTO content_receipts(sha256, verified_sha256, verified_byte_length, verified_at)
          VALUES (${input.sha256}, ${input.sha256}, ${input.byteLength}, ${input.verifiedAt})
          ON CONFLICT(sha256) DO UPDATE SET verified_sha256 = excluded.verified_sha256,
            verified_byte_length = excluded.verified_byte_length, verified_at = excluded.verified_at`;
        return { created: Option.isNone(existing) };
      }, Effect.mapError(manifestError)),
      recordContentRef: Effect.fn("ContentManifest.recordContentRef")(function* (input) {
        const object = yield* getObject(input.ref.sha256);
        if (Option.isNone(object)) {
          return yield* Effect.fail(new ContentManifestError("order", "content ref requires a durable content_objects row first"));
        }
        if (object.value.byteLength !== input.ref.byteLength) {
          return yield* Effect.fail(new ContentManifestError("conflict", "content ref byteLength does not match content_objects"));
        }
        const ref = input.ref;
        const refId = input.refId ?? `cref_${randomBytes(16).toString("hex")}`;
        const createdAt = input.createdAt ?? new Date().toISOString();
        yield* sql`INSERT INTO content_refs(ref_id, sha256, byte_length, media_type, display_name,
          owner_kind, owner_canvas, owner_node, owner_record_id, created_at)
          VALUES (${refId}, ${ref.sha256}, ${ref.byteLength}, ${ref.mediaType}, ${ref.displayName ?? null},
            ${input.owner.kind}, ${input.owner.canvasName}, ${input.owner.nodeId}, ${input.owner.recordId}, ${createdAt})`;
        return { refId, ref, owner: input.owner, createdAt };
      }, Effect.mapError(manifestError)),
      getContentObject: (sha256) => getObject(sha256).pipe(Effect.map(Option.getOrUndefined), Effect.mapError(manifestError)),
      listContentRefsForObject: (sha256) => refs(sha256).pipe(
        Effect.map((rows) => rows.map((row): ContentRefRow => ({
          refId: row.refId,
          ref: {
            sha256: row.sha256, byteLength: row.byteLength, mediaType: row.mediaType,
            ...(row.displayName === null ? {} : { displayName: row.displayName }),
          },
          owner: { kind: row.ownerKind, canvasName: row.ownerCanvas, nodeId: row.ownerNode, recordId: row.ownerRecordId },
          createdAt: row.createdAt,
        }))), Effect.mapError(manifestError)),
      manifestAvailability: Effect.fn("ContentManifest.manifestAvailability")(function* (ref): Effect.fn.Return<ContentAvailability, unknown> {
        const object = yield* getObject(ref.sha256);
        if (Option.isNone(object)) {
          return { ref, state: "missing", reason: ContentAvailabilityReason.make("content object is not in the local manifest") };
        }
        if (object.value.byteLength !== ref.byteLength) {
          return { ref, state: "corrupt", reason: ContentAvailabilityReason.make("manifest byte_length does not match ContentRef"), observedByteLength: object.value.byteLength };
        }
        const receipt = yield* getReceipt(ref.sha256);
        if (Option.isNone(receipt)) {
          return { ref, state: "unavailable", reason: ContentAvailabilityReason.make("content object has no verification receipt") };
        }
        if (receipt.value.verifiedSha256 !== ref.sha256 || receipt.value.verifiedByteLength !== ref.byteLength) {
          return { ref, state: "corrupt", reason: ContentAvailabilityReason.make("content receipt does not match ContentRef"), observedSha256: receipt.value.verifiedSha256, observedByteLength: receipt.value.verifiedByteLength };
        }
        return { ref, state: "verified", ...receipt.value };
      }, Effect.mapError(manifestError)),
      listReferencedContentDigests: () => referenced(undefined).pipe(Effect.mapError(manifestError)),
      listActiveTransferDigests: () => active(undefined).pipe(Effect.mapError(manifestError)),
      listContentObjectsWithRefCounts: () => objects(undefined).pipe(Effect.mapError(manifestError)),
      deleteUnreferencedContentObject: Effect.fn("ContentManifest.deleteUnreferencedContentObject")(function* (sha256) {
        if (!/^[a-f0-9]{64}$/u.test(sha256)) {
          return yield* Effect.fail(new ContentManifestError("invalid", "sha256 must be lower-case hex"));
        }
        const protectedBy = yield* protectedObject(sha256);
        if (protectedBy.refs > 0) {
          return yield* Effect.fail(new ContentManifestError("conflict", `cannot GC content object ${sha256}: still referenced`));
        }
        if (protectedBy.active > 0) {
          return yield* Effect.fail(new ContentManifestError("conflict", `cannot GC content object ${sha256}: transfer still active`));
        }
        const object = yield* getObject(sha256);
        if (Option.isNone(object)) return { deleted: false };
        yield* sql`DELETE FROM content_receipts WHERE sha256 = ${sha256}`;
        yield* sql`DELETE FROM content_objects WHERE sha256 = ${sha256}`;
        return { deleted: true };
      }, Effect.mapError(manifestError)),
      upsertContentTransfer: Effect.fn("ContentManifest.upsertContentTransfer")(function* (input) {
        const transferId = input.transferId ?? `xfer_${randomBytes(16).toString("hex")}`;
        const now = new Date().toISOString();
        const createdAt = input.createdAt ?? now;
        const updatedAt = input.updatedAt ?? now;
        yield* sql`INSERT INTO content_transfers(transfer_id, sha256, byte_length, state, direction,
          peer_installation_id, error_reason, created_at, updated_at)
          VALUES (${transferId}, ${input.sha256}, ${input.byteLength}, ${input.state}, ${input.direction},
            ${input.peerInstallationId ?? null}, ${input.errorReason ?? null}, ${createdAt}, ${updatedAt})
          ON CONFLICT(transfer_id) DO UPDATE SET sha256 = excluded.sha256, byte_length = excluded.byte_length,
            state = excluded.state, direction = excluded.direction, peer_installation_id = excluded.peer_installation_id,
            error_reason = excluded.error_reason, updated_at = excluded.updated_at`;
        return { ...input, transferId, createdAt, updatedAt };
      }, Effect.mapError(manifestError)),
    });
  }));
}
