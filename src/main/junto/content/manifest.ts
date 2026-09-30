import { randomBytes } from "node:crypto";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema, type SqlError } from "effect/unstable/sql";
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

export type ContentObjectAgeRow = ContentObjectRow & {
  readonly refCount: number;
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
  readonly code:
    | "missing"
    | "conflict"
    | "invalid"
    | "order"
    | "sql"
    | "decode";

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

export type ContentManifestShape = {
  /** Record only after the object file is durable. Idempotent on matching identity. */
  readonly recordContentObject: (input: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly verifiedAt: string;
    readonly createdAt?: string;
  }) => Effect.Effect<{ readonly created: boolean }, ContentManifestError>;
  /** Bind an owner only after the object row exists; never create dangling refs. */
  readonly recordContentRef: (input: {
    readonly ref: ContentRef;
    readonly owner: ContentOwner;
    readonly refId?: string;
    readonly createdAt?: string;
  }) => Effect.Effect<ContentRefRow, ContentManifestError>;
  readonly getContentObject: (
    sha256: string,
  ) => Effect.Effect<ContentObjectRow | undefined, ContentManifestError>;
  readonly listContentRefsForObject: (
    sha256: string,
  ) => Effect.Effect<ReadonlyArray<ContentRefRow>, ContentManifestError>;
  /** Object row + receipt only. Callers combine with filesystem verification. */
  readonly manifestAvailability: (
    ref: ContentRef,
  ) => Effect.Effect<ContentAvailability, ContentManifestError>;
  readonly listReferencedContentDigests: () => Effect.Effect<
    ReadonlyArray<{ readonly sha256: string; readonly byteLength: number }>,
    ContentManifestError
  >;
  readonly listActiveTransferDigests: () => Effect.Effect<
    ReadonlyArray<{
      readonly sha256: string;
      readonly byteLength: number;
      readonly transferId: string;
      readonly state: ContentTransferState;
    }>,
    ContentManifestError
  >;
  readonly listContentObjectsWithRefCounts: () => Effect.Effect<
    ReadonlyArray<ContentObjectAgeRow>,
    ContentManifestError
  >;
  /** Recheck refs and active transfers before removing the object and receipt. */
  readonly deleteUnreferencedContentObject: (
    sha256: string,
  ) => Effect.Effect<{ readonly deleted: boolean }, ContentManifestError>;
  readonly upsertContentTransfer: (input: {
    readonly transferId?: string;
    readonly sha256: string;
    readonly byteLength: number;
    readonly state: ContentTransferState;
    readonly direction: ContentTransferDirection;
    readonly peerInstallationId?: string;
    readonly errorReason?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
  }) => Effect.Effect<ContentTransferRow, ContentManifestError>;
};

const ObjectRow = Schema.Struct({
  sha256: ContentSha256,
  byteLength: ContentByteLength,
  createdAt: ContentTimestamp,
  verifiedAt: ContentTimestamp,
});
const IdentityRow = Schema.Struct({
  sha256: ContentSha256,
  byteLength: ContentByteLength,
});
const RefRow = Schema.Struct({
  refId: Schema.String,
  ...IdentityRow.fields,
  mediaType: ContentMediaType,
  displayName: Schema.NullOr(ContentDisplayName),
  ownerKind: Schema.Literals([
    "task",
    "message",
    "artifact",
    "board_topic",
    "board_post",
    "other",
  ]),
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
const ObjectAgeRow = Schema.Struct({
  ...ObjectRow.fields,
  refCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const manifestError = (cause: unknown): ContentManifestError => {
  if (cause instanceof ContentManifestError) return cause;
  return new ContentManifestError(
    Schema.isSchemaError(cause) ? "decode" : "sql",
    cause instanceof Error ? cause.message : String(cause),
    { cause },
  );
};

/** SQL-only ledger capability. Methods join the caller's transaction context. */
export class ContentManifest extends Context.Service<
  ContentManifest,
  ContentManifestShape
>()("@junto/ContentManifest") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
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
        execute: (
          sha256,
        ) => sql`SELECT ref_id AS refId, sha256, byte_length AS byteLength,
        media_type AS mediaType, display_name AS displayName, owner_kind AS ownerKind,
        owner_canvas AS ownerCanvas, owner_node AS ownerNode, owner_record_id AS ownerRecordId,
        created_at AS createdAt FROM content_refs WHERE sha256 = ${sha256} ORDER BY created_at, ref_id`,
      });
      const referenced = SqlSchema.findAll({
        Request: Schema.Void,
        Result: IdentityRow,
        execute: () =>
          sql`SELECT DISTINCT sha256, byte_length AS byteLength FROM content_refs ORDER BY sha256`,
      });
      const active = SqlSchema.findAll({
        Request: Schema.Void,
        Result: ActiveTransferRow,
        execute:
          () => sql`SELECT transfer_id AS transferId, sha256, byte_length AS byteLength, state
        FROM content_transfers WHERE state IN ('pending', 'receiving', 'verifying') ORDER BY sha256, transfer_id`,
      });
      const objects = SqlSchema.findAll({
        Request: Schema.Void,
        Result: ObjectAgeRow,
        execute:
          () => sql`SELECT o.sha256, o.byte_length AS byteLength, o.created_at AS createdAt,
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
        recordContentObject: Effect.fn("ContentManifest.recordContentObject")(
          function* (input) {
            if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
              return yield* Effect.fail(
                new ContentManifestError(
                  "invalid",
                  "sha256 must be lower-case hex",
                ),
              );
            }
            if (
              !Number.isSafeInteger(input.byteLength) ||
              input.byteLength < 0
            ) {
              return yield* Effect.fail(
                new ContentManifestError(
                  "invalid",
                  "byteLength must be a safe integer",
                ),
              );
            }
            const existing = yield* getObject(input.sha256);
            if (
              Option.isSome(existing) &&
              existing.value.byteLength !== input.byteLength
            ) {
              return yield* Effect.fail(
                new ContentManifestError(
                  "conflict",
                  `content object ${input.sha256} already exists with a different length`,
                ),
              );
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
          },
          Effect.mapError(manifestError),
        ),
        recordContentRef: Effect.fn("ContentManifest.recordContentRef")(
          function* (input) {
            const object = yield* getObject(input.ref.sha256);
            if (Option.isNone(object)) {
              return yield* Effect.fail(
                new ContentManifestError(
                  "order",
                  "content ref requires a durable content_objects row first",
                ),
              );
            }
            if (object.value.byteLength !== input.ref.byteLength) {
              return yield* Effect.fail(
                new ContentManifestError(
                  "conflict",
                  "content ref byteLength does not match content_objects",
                ),
              );
            }
            const ref = input.ref;
            const refId =
              input.refId ?? `cref_${randomBytes(16).toString("hex")}`;
            const createdAt = input.createdAt ?? new Date().toISOString();
            yield* sql`INSERT INTO content_refs(ref_id, sha256, byte_length, media_type, display_name,
          owner_kind, owner_canvas, owner_node, owner_record_id, created_at)
          VALUES (${refId}, ${ref.sha256}, ${ref.byteLength}, ${ref.mediaType}, ${ref.displayName ?? null},
            ${input.owner.kind}, ${input.owner.canvasName}, ${input.owner.nodeId}, ${input.owner.recordId}, ${createdAt})`;
            return { refId, ref, owner: input.owner, createdAt };
          },
          Effect.mapError(manifestError),
        ),
        getContentObject: (sha256) =>
          getObject(sha256).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(manifestError),
          ),
        listContentRefsForObject: (sha256) =>
          refs(sha256).pipe(
            Effect.map((rows) =>
              rows.map(
                (row): ContentRefRow => ({
                  refId: row.refId,
                  ref: {
                    sha256: row.sha256,
                    byteLength: row.byteLength,
                    mediaType: row.mediaType,
                    ...(row.displayName === null
                      ? {}
                      : { displayName: row.displayName }),
                  },
                  owner: {
                    kind: row.ownerKind,
                    canvasName: row.ownerCanvas,
                    nodeId: row.ownerNode,
                    recordId: row.ownerRecordId,
                  },
                  createdAt: row.createdAt,
                }),
              ),
            ),
            Effect.mapError(manifestError),
          ),
        manifestAvailability: Effect.fn("ContentManifest.manifestAvailability")(
          function* (
            ref,
          ): Effect.fn.Return<
            ContentAvailability,
            Schema.SchemaError | SqlError.SqlError
          > {
            const object = yield* getObject(ref.sha256);
            if (Option.isNone(object)) {
              return {
                ref,
                state: "missing",
                reason: ContentAvailabilityReason.make(
                  "content object is not in the local manifest",
                ),
              };
            }
            if (object.value.byteLength !== ref.byteLength) {
              return {
                ref,
                state: "corrupt",
                reason: ContentAvailabilityReason.make(
                  "manifest byte_length does not match ContentRef",
                ),
                observedByteLength: object.value.byteLength,
              };
            }
            const receipt = yield* getReceipt(ref.sha256);
            if (Option.isNone(receipt)) {
              return {
                ref,
                state: "unavailable",
                reason: ContentAvailabilityReason.make(
                  "content object has no verification receipt",
                ),
              };
            }
            if (
              receipt.value.verifiedSha256 !== ref.sha256 ||
              receipt.value.verifiedByteLength !== ref.byteLength
            ) {
              return {
                ref,
                state: "corrupt",
                reason: ContentAvailabilityReason.make(
                  "content receipt does not match ContentRef",
                ),
                observedSha256: receipt.value.verifiedSha256,
                observedByteLength: receipt.value.verifiedByteLength,
              };
            }
            return { ref, state: "verified", ...receipt.value };
          },
          Effect.mapError(manifestError),
        ),
        listReferencedContentDigests: () =>
          referenced(undefined).pipe(Effect.mapError(manifestError)),
        listActiveTransferDigests: () =>
          active(undefined).pipe(Effect.mapError(manifestError)),
        listContentObjectsWithRefCounts: () =>
          objects(undefined).pipe(Effect.mapError(manifestError)),
        deleteUnreferencedContentObject: Effect.fn(
          "ContentManifest.deleteUnreferencedContentObject",
        )(function* (sha256) {
          if (!/^[a-f0-9]{64}$/u.test(sha256)) {
            return yield* Effect.fail(
              new ContentManifestError(
                "invalid",
                "sha256 must be lower-case hex",
              ),
            );
          }
          const protectedBy = yield* protectedObject(sha256);
          if (protectedBy.refs > 0) {
            return yield* Effect.fail(
              new ContentManifestError(
                "conflict",
                `cannot GC content object ${sha256}: still referenced`,
              ),
            );
          }
          if (protectedBy.active > 0) {
            return yield* Effect.fail(
              new ContentManifestError(
                "conflict",
                `cannot GC content object ${sha256}: transfer still active`,
              ),
            );
          }
          const object = yield* getObject(sha256);
          if (Option.isNone(object)) return { deleted: false };
          yield* sql`DELETE FROM content_receipts WHERE sha256 = ${sha256}`;
          yield* sql`DELETE FROM content_objects WHERE sha256 = ${sha256}`;
          return { deleted: true };
        }, Effect.mapError(manifestError)),
        upsertContentTransfer: Effect.fn(
          "ContentManifest.upsertContentTransfer",
        )(function* (input) {
          const transferId =
            input.transferId ?? `xfer_${randomBytes(16).toString("hex")}`;
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
    }),
  );
}
