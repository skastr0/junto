import { Context, Effect, Layer } from "effect";
import type {
  ContentAvailability,
  ContentAvailabilityReason,
  ContentRef,
} from "@shared/content";
import { resolveVellumHome } from "@shared/vellum-home";
import {
  StateEngine,
  StateEngineError,
  type StateBackupReceipt,
  type StateEngineShape,
} from "../state/service";
import {
  createContentSnapshot,
  type ContentSnapshotReceipt,
} from "./backup";
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
  listContentRefsForObject,
  manifestAvailability,
  recordContentObject,
  recordContentRef,
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
  | StateEngineError;

export type ContentOpenForRead = ContentOpenResult;

type StateService = StateEngineShape;

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
  ) => Effect.Effect<ContentAvailability, StateEngineError>;
  /**
   * Open for streaming reads. Checks manifest receipt + path/size without
   * re-hashing the full object (so video range seeks stay cheap).
   */
  readonly openForRead: (
    ref: ContentRef,
  ) => Effect.Effect<ContentOpenForRead, StateEngineError>;
  readonly localPath: (
    ref: ContentRef,
  ) => Effect.Effect<ReturnType<typeof projectContentLocalPath>, never>;
  readonly listRefs: (
    sha256: string,
  ) => Effect.Effect<ReadonlyArray<ContentRefRow>, StateEngineError>;
  /** Startup / recovery integrity over referenced digests. */
  readonly integrityCheck: () => Effect.Effect<
    ContentIntegrityReport,
    StateEngineError | ContentStoreError
  >;
  /**
   * Conservative mark-and-sweep. Defaults to dry-run; pass
   * `{ dryRun: false }` for a live sweep.
   */
  readonly collectGarbage: (
    options?: ContentGcOptions,
  ) => Effect.Effect<
    ContentGcReport,
    StateEngineError | ContentStoreError | ContentManifestError
  >;
  /**
   * Snapshot every content_refs object. Optionally attach a prior
   * StateEngine VACUUM backup receipt so DB + objects are one product unit.
   */
  readonly snapshot: (options?: {
    readonly stateBackup?: StateBackupReceipt;
  }) => Effect.Effect<
    ContentSnapshotReceipt,
    StateEngineError | ContentStoreError
  >;
  /** Probe disk admission for a prospective write size. */
  readonly admitWrite: (input: {
    readonly needBytes: number;
    readonly reserveBytes?: number;
    readonly freeBytes?: number;
  }) => Effect.Effect<ContentDiskAdmission, ContentStoreError>;
};

/**
 * Local content store + SQLite manifest. Main owns the only DB connection;
 * this service never opens `vellum.db` itself.
 *
 * effect-foundation **S4-state-content** (staged, not half-migrated):
 * - Canonical id: `@vellum/ContentService` — single definition; no dual path.
 * - Substrate: effect@3.21 → `Context.Tag` (`Context.Service` unavailable).
 * - V4 target:
 *   `class ContentService extends Context.Service<ContentService, ContentServiceShape>()("@vellum/ContentService") {}`
 * - Layer today: `makeContentServiceLive` — V4 rename candidate
 *   `ContentService.layer` (no dual Live+layer export).
 * - Hard law: yield ContentService from warm Layer Context; never ambient
 *   empty-context lookup (claim-gate class of bug).
 */
export class ContentService extends Context.Service<ContentService,
  ContentServiceShape>()("@vellum/ContentService") {}

const makeContentService = (
  state: StateService,
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
      const refRow = yield* state.transaction("content.put", (writer) => {
        recordContentObject(writer, {
          sha256: ingested.ref.sha256,
          byteLength: ingested.ref.byteLength,
          verifiedAt: ingested.verifiedAt,
        });
        if (input.owner === undefined) return undefined;
        return recordContentRef(writer, {
          ref: ingested.ref,
          owner: input.owner,
          createdAt: ingested.verifiedAt,
        });
      });

      return { ...ingested, refRow };
    }),

  availability: (ref) =>
    state.read("content.availability", (reader) => {
      const fromManifest = manifestAvailability(reader, ref);
      if (fromManifest.state !== "verified") return fromManifest;
      return verifyContentObjectFile(root, ref, fromManifest.verifiedAt);
    }),

  openForRead: (ref) =>
    state.read("content.openForRead", (reader): ContentOpenForRead => {
      const fromManifest = manifestAvailability(reader, ref);
      if (fromManifest.state !== "verified") return fromManifest;
      const projection = projectContentLocalPath(root, ref);
      if ("kind" in projection && projection.kind === "local-path") {
        return {
          state: "verified",
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
        state: "unavailable",
        reason:
          "content object could not be opened for read" as ContentAvailabilityReason,
      };
    }),

  localPath: (ref) => Effect.sync(() => projectContentLocalPath(root, ref)),

  listRefs: (sha256) =>
    state.read("content.listRefs", (reader) =>
      listContentRefsForObject(reader, sha256),
    ),

  integrityCheck: () =>
    Effect.gen(function* () {
      const boxed = yield* state.read("content.integrity", (reader) => {
        try {
          return {
            ok: true as const,
            report: runContentIntegrityCheck(root, reader),
          };
        } catch (error) {
          if (error instanceof ContentStoreError) {
            return { ok: false as const, error };
          }
          throw error;
        }
      });
      if (!boxed.ok) return yield* Effect.fail(boxed.error);
      return boxed.report;
    }),

  collectGarbage: (options) => {
    const dryRun = options?.dryRun !== false;
    if (dryRun) {
      return Effect.gen(function* () {
        const boxed = yield* state.read("content.gc.dryRun", (reader) => {
          try {
            return {
              ok: true as const,
              report: collectContentGarbage(root, reader, undefined, {
                ...options,
                dryRun: true,
              }),
            };
          } catch (error) {
            if (
              error instanceof ContentStoreError ||
              error instanceof ContentManifestError
            ) {
              return { ok: false as const, error };
            }
            throw error;
          }
        });
        if (!boxed.ok) return yield* Effect.fail(boxed.error);
        return boxed.report;
      });
    }
    return Effect.gen(function* () {
      const boxed = yield* state.transaction("content.gc.sweep", (writer) => {
        try {
          return {
            ok: true as const,
            report: collectContentGarbage(root, writer, writer, {
              ...options,
              dryRun: false,
            }),
          };
        } catch (error) {
          if (
            error instanceof ContentStoreError ||
            error instanceof ContentManifestError
          ) {
            return { ok: false as const, error };
          }
          throw error;
        }
      });
      if (!boxed.ok) return yield* Effect.fail(boxed.error);
      return boxed.report;
    });
  },

  snapshot: (options) =>
    Effect.gen(function* () {
      const boxed = yield* state.read("content.snapshot", (reader) => {
        try {
          return {
            ok: true as const,
            receipt: createContentSnapshot(root, reader, {
              stateBackup: options?.stateBackup,
            }),
          };
        } catch (error) {
          if (error instanceof ContentStoreError) {
            return { ok: false as const, error };
          }
          throw error;
        }
      });
      if (!boxed.ok) return yield* Effect.fail(boxed.error);
      return boxed.receipt;
    }),

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
}): Layer.Layer<ContentService, never, StateEngine | InstallOpsService> =>
  Layer.effect(
    ContentService,
    Effect.gen(function* () {
      const state = yield* StateEngine;
      const installOps = yield* InstallOpsService;
      const root =
        options?.root ??
        contentStoreRoot(options?.home ?? resolveVellumHome());
      ensureContentLayout(root);
      if (options?.skipInlineMediaMigration !== true) {
        // Install-ops marker-gated walk over product projections only. A
        // failure must never gate app startup: log it, leave the marker
        // pending, and the walk resumes on the next boot.
        yield* Effect.tryPromise({
          try: () =>
            runInlineMediaMigration({ state, root, installOps }),
          catch: (cause) => {
            if (cause instanceof InlineMediaMigrationError) return cause;
            if (cause instanceof ContentStoreError) return cause;
            return new InlineMediaMigrationError(
              cause instanceof Error ? cause.message : String(cause),
              { cause },
            );
          },
        }).pipe(
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
      return makeContentService(state, root);
    }),
  );

/** Test helper: build the service against an already-open engine + root. */
export const createContentService = (
  state: StateService,
  root: string,
): ContentServiceShape => makeContentService(state, root);

export { ContentManifestError, ContentStoreError };
