import { randomBytes } from "node:crypto";
import type {
  ContentAvailability,
  ContentAvailabilityReason,
  ContentByteLength,
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
  readonly code: "missing" | "conflict" | "invalid" | "order";

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
