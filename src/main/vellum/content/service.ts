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
} from "../state/service";
import {
  listContentRefsForObject,
  manifestAvailability,
  recordContentObject,
  recordContentRef,
  type ContentOwner,
  type ContentRefRow,
  ContentManifestError,
} from "./manifest";
import { contentStoreRoot } from "./paths";
import {
  ContentStoreError,
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
};

export type ContentPutResult = ContentIngestResult & {
  readonly refRow?: ContentRefRow;
};

export type ContentServiceError =
  | ContentStoreError
  | ContentManifestError
  | StateEngineError;

export type ContentOpenForRead = ContentOpenResult;

type StateService = Context.Tag.Service<typeof StateEngine>;

/**
 * Local content store + SQLite manifest. Main owns the only DB connection;
 * this service never opens `vellum.db` itself.
 */
export class ContentService extends Context.Tag("@vellum/ContentService")<
  ContentService,
  {
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
  }
>() {}

const makeContentService = (
  state: StateService,
  root: string,
): Context.Tag.Service<typeof ContentService> => ({
  root,

  put: (input) =>
    Effect.gen(function* () {
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
});

export const makeContentServiceLive = (options?: {
  readonly home?: string;
  readonly root?: string;
}): Layer.Layer<ContentService, never, StateEngine> =>
  Layer.effect(
    ContentService,
    Effect.gen(function* () {
      const state = yield* StateEngine;
      const root =
        options?.root ??
        contentStoreRoot(options?.home ?? resolveVellumHome());
      return makeContentService(state, root);
    }),
  );

/** Test helper: build the service against an already-open engine + root. */
export const createContentService = (
  state: StateService,
  root: string,
): Context.Tag.Service<typeof ContentService> =>
  makeContentService(state, root);

export { ContentManifestError, ContentStoreError };
