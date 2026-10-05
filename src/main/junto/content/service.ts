import { Cause, Context, Effect, Layer, Result } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import type {
  ContentAvailability,
  ContentAvailabilityReason,
  ContentRef,
} from "@shared/content";
import { resolveJuntoHome } from "@shared/junto-home";
import {
  StateTransactionOperation,
  type StateBackupReceipt,
} from "../state/service";
import { withSqlRead } from "../state/sql-read";
import {
  WorkContentProjections,
  WorkContentProjectionsLive,
} from "../work/repository";
import { createContentSnapshot, type ContentSnapshotReceipt } from "./backup";
import {
  admitContentWrite,
  assertContentDiskAdmission,
  type ContentDiskAdmission,
} from "./disk-admission";
import {
  collectContentGarbage,
  type ContentGcOptions,
  type ContentGcReport,
} from "./gc";
import {
  runContentIntegrityCheck,
  type ContentIntegrityReport,
} from "./integrity";
import {
  ContentManifest,
  type ContentManifestShape,
  type ContentOwner,
  type ContentRefRow,
  ContentManifestError,
} from "./manifest";
import {
  InlineMediaMigrationError,
  runInlineMediaMigration,
} from "./inline-media-migration";
import { InstallOpsService } from "../install-ops/engine";
import { contentStoreRoot } from "./paths";
import {
  ContentStoreError,
  ensureContentLayout,
  ingestContentBytes,
  projectContentLocalPath,
  verifyContentObjectFile,
  type ContentByteSource,
  type ContentIngestResult,
} from "./store";
import type { ContentOpenResult } from "./protocol";

export type ContentPutInput = {
  readonly source: ContentByteSource;
  readonly mediaType: string;
  readonly displayName?: string;
  readonly expected?: Pick<ContentRef, "sha256" | "byteLength">;
  /** Bind a ref only after the object is durable. Optional. */
  readonly owner?: ContentOwner;
  /**
   * Test/injection hook for free-space admission. Production omits this and
   * probes the content volume via statfs.
   */
  readonly diskFreeBytes?: number;
  readonly diskReserveBytes?: number;
};

export type ContentPutResult = ContentIngestResult & {
  readonly refRow?: ContentRefRow;
};

export type ContentServiceError =
  | ContentStoreError
  | ContentManifestError
  | SqlError.SqlError;

export type ContentOpenForRead = ContentOpenResult;

/**
 * Implementation shape for {@link ContentService}.
 * Named so the V4 swap is a one-line Tag→Service change, not a reshape.
 */
export type ContentServiceShape = {
  readonly root: string;
  readonly put: (
    input: ContentPutInput,
  ) => Effect.Effect<ContentPutResult, ContentServiceError>;
  readonly availability: (
    ref: ContentRef,
  ) => Effect.Effect<
    ContentAvailability,
    ContentManifestError | SqlError.SqlError
  >;
  /**
   * Open for streaming reads. Checks manifest receipt + path/size without
   * re-hashing the full object (so video range seeks stay cheap).
   */
  readonly openForRead: (
    ref: ContentRef,
  ) => Effect.Effect<
    ContentOpenForRead,
    ContentManifestError | SqlError.SqlError
  >;
  readonly localPath: (
    ref: ContentRef,
  ) => Effect.Effect<ReturnType<typeof projectContentLocalPath>, never>;
  readonly listRefs: (
    sha256: string,
  ) => Effect.Effect<ReadonlyArray<ContentRefRow>, ContentManifestError>;
  /**
   * Release every reference an owner holds (a closed signal's attachments).
   * The bytes go at the next garbage collection that finds them unreferenced.
   */
  readonly releaseOwner: (
    owner: ContentOwner,
  ) => Effect.Effect<number, ContentManifestError | SqlError.SqlError>;
  /** Startup / recovery integrity over referenced digests. */
  readonly integrityCheck: () => Effect.Effect<
    ContentIntegrityReport,
    ContentServiceError
  >;
  /**
   * Conservative mark-and-sweep. Defaults to dry-run; pass
   * `{ dryRun: false }` for a live sweep.
   */
  readonly collectGarbage: (
    options?: ContentGcOptions,
  ) => Effect.Effect<ContentGcReport, ContentServiceError>;
  /**
   * Snapshot every content_refs object. Optionally attach a prior
   * StateEngine VACUUM backup receipt so DB + objects are one product unit.
   */
  readonly snapshot: (options?: {
    readonly stateBackup?: StateBackupReceipt;
  }) => Effect.Effect<ContentSnapshotReceipt, ContentServiceError>;
  /** Probe disk admission for a prospective write size. */
  readonly admitWrite: (input: {
    readonly needBytes: number;
    readonly reserveBytes?: number;
    readonly freeBytes?: number;
  }) => Effect.Effect<ContentDiskAdmission, ContentStoreError>;
};

/**
 * Local content store + SQLite manifest. Main owns the only DB connection;
 * this service never opens `junto.db` itself.
 *
 * - Canonical id: `@junto/ContentService` — single `Context.Service` definition.
 * - Layer: `makeContentServiceLive`.
 * - Hard law: yield ContentService from warm Layer Context; never ambient
 *   empty-context lookup (claim-gate class of bug).
 */
export class ContentService extends Context.Service<
  ContentService,
  ContentServiceShape
>()("@junto/ContentService") {}

const makeContentService = (
  sql: SqlClient.SqlClient,
  manifest: ContentManifestShape,
  root: string,
): ContentServiceShape => ({
  root,

  put: (input) =>
    Effect.gen(function* () {
      ensureContentLayout(root);
      // Disk admission before streaming bytes: known expected size, else
      // admit with needBytes=0 so only the reserve must be free (mid-stream
      // ENOSPC still surfaces as io/disk-low from the OS).
      const needBytes = input.expected?.byteLength ?? 0;
      yield* Effect.try({
        try: () =>
          assertContentDiskAdmission({
            root,
            needBytes,
            reserveBytes: input.diskReserveBytes,
            freeBytes: input.diskFreeBytes,
          }),
        catch: (cause) => {
          if (cause instanceof ContentStoreError) return cause;
          return new ContentStoreError(
            "io",
            cause instanceof Error ? cause.message : String(cause),
            { cause },
          );
        },
      });

      // 1) Durable object on disk first (crash → orphan file only).
      const ingested = yield* Effect.tryPromise({
        try: () =>
          ingestContentBytes({
            root,
            source: input.source,
            mediaType: input.mediaType,
            displayName: input.displayName,
            expected: input.expected,
          }),
        catch: (cause) => {
          if (cause instanceof ContentStoreError) return cause;
          return new ContentStoreError(
            "io",
            cause instanceof Error ? cause.message : String(cause),
            { cause },
          );
        },
      });

      // 2) Manifest only after file publish.
      const refRow = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* manifest.recordContentObject({
              sha256: ingested.ref.sha256,
              byteLength: ingested.ref.byteLength,
              verifiedAt: ingested.verifiedAt,
            });
            if (input.owner === undefined) return undefined;
            return yield* manifest.recordContentRef({
              ref: ingested.ref,
              owner: input.owner,
              createdAt: ingested.verifiedAt,
            });
          }),
        )
        .pipe(Effect.provideService(StateTransactionOperation, "content.put"));

      return { ...ingested, refRow };
    }),

  availability: (ref) =>
    withSqlRead(
      sql,
      Effect.gen(function* () {
        const fromManifest = yield* manifest.manifestAvailability(ref);
        if (fromManifest.state !== "verified") return fromManifest;
        return verifyContentObjectFile(root, ref, fromManifest.verifiedAt);
      }),
    ),

  openForRead: (ref) =>
    withSqlRead(
      sql,
      Effect.gen(function* () {
        const fromManifest = yield* manifest.manifestAvailability(ref);
        if (fromManifest.state !== "verified") return fromManifest;
        const projection = projectContentLocalPath(root, ref);
        if ("kind" in projection && projection.kind === "local-path") {
          return {
            state: "verified" as const,
            path: projection.path,
            byteLength: ref.byteLength,
            mediaType: ref.mediaType,
          };
        }
        if (
          "state" in projection &&
          (projection.state === "missing" ||
            projection.state === "corrupt" ||
            projection.state === "unavailable")
        ) {
          return projection;
        }
        return {
          ref,
          state: "unavailable" as const,
          reason:
            "content object could not be opened for read" as ContentAvailabilityReason,
        };
      }),
    ),

  localPath: (ref) => Effect.sync(() => projectContentLocalPath(root, ref)),

  listRefs: (sha256) => manifest.listContentRefsForObject(sha256),

  releaseOwner: (owner) =>
    sql
      .withTransaction(manifest.releaseContentRefsForOwner(owner))
      .pipe(
        Effect.provideService(
          StateTransactionOperation,
          "content.releaseOwner",
        ),
      ),

  integrityCheck: () =>
    withSqlRead(sql, runContentIntegrityCheck(root, manifest)),

  collectGarbage: (options) =>
    (options?.dryRun !== false
      ? withSqlRead(sql, collectContentGarbage(root, manifest, options))
      : sql
          .withTransaction(
            collectContentGarbage(root, manifest, options).pipe(
              Effect.map(Result.succeed),
              // Only domain failures historically commit completed sweep steps.
              Effect.catch((error) =>
                error instanceof ContentStoreError ||
                (error instanceof ContentManifestError &&
                  error.code !== "sql" &&
                  error.code !== "decode")
                  ? Effect.succeed(Result.fail(error))
                  : Effect.fail(error),
              ),
            ),
          )
          .pipe(
            Effect.provideService(
              StateTransactionOperation,
              "content.gc.sweep",
            ),
            Effect.flatMap(Effect.fromResult),
          )
    ).pipe(
      Effect.mapError((error) =>
        Cause.isUnknownError(error)
          ? new ContentStoreError("io", error.message, { cause: error.cause })
          : error,
      ),
    ),

  snapshot: (options) =>
    withSqlRead(sql, createContentSnapshot(root, manifest, options)),

  admitWrite: (input) =>
    Effect.try({
      try: () => {
        ensureContentLayout(root);
        return admitContentWrite({
          root,
          needBytes: input.needBytes,
          reserveBytes: input.reserveBytes,
          freeBytes: input.freeBytes,
        });
      },
      catch: (cause) => {
        if (cause instanceof ContentStoreError) return cause;
        return new ContentStoreError(
          "io",
          cause instanceof Error ? cause.message : String(cause),
          { cause },
        );
      },
    }),
});

export const makeContentServiceLive = (options?: {
  readonly home?: string;
  readonly root?: string;
  /**
   * Test hook: skip the one-shot historical Base64 → content-store walk.
   * Production never sets this; install-ops ledger is the authority.
   */
  readonly skipInlineMediaMigration?: boolean;
}): Layer.Layer<
  ContentService,
  never,
  SqlClient.SqlClient | InstallOpsService
> =>
  Layer.effect(
    ContentService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const manifest = yield* ContentManifest;
      const projections = yield* WorkContentProjections;
      const installOps = yield* InstallOpsService;
      const home = options?.home ?? resolveJuntoHome();
      const root = options?.root ?? contentStoreRoot(home);
      ensureContentLayout(root);
      if (options?.skipInlineMediaMigration !== true) {
        // Install-ops marker-gated walk over product projections only. A
        // failure must never gate app startup: log it, leave the marker
        // pending, and the walk resumes on the next boot.
        yield* runInlineMediaMigration({
          sql,
          manifest,
          projections,
          root,
          installOps,
        }).pipe(
          Effect.mapError((cause) => {
            if (cause instanceof InlineMediaMigrationError) return cause;
            if (cause instanceof ContentStoreError) return cause;
            return new InlineMediaMigrationError(
              cause instanceof Error ? cause.message : String(cause),
              { cause },
            );
          }),
          Effect.catch((error) =>
            Effect.sync(() => {
              console.error(
                "[content] inline media backfill deferred to next boot:",
                error,
              );
            }),
          ),
        );
      }
      return makeContentService(sql, manifest, root);
    }),
  ).pipe(Layer.provide([ContentManifest.layer, WorkContentProjectionsLive]));

/** Test helper: build the service against an already-open engine + root. */
export const createContentService = (
  sql: SqlClient.SqlClient,
  manifest: ContentManifestShape,
  root: string,
): ContentServiceShape => makeContentService(sql, manifest, root);

export { ContentManifestError, ContentStoreError };
