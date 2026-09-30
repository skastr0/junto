/**
 * Marker-gated, per-row externalization of historical inline media. Only Work
 * material projections are rewritten; immutable logs retain their original
 * payloads. Completeness lives in install-ops.db, never in product state.
 * Failures leave the marker pending and the boot layer defers to next boot.
 */
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import type { ContentRef } from "@shared/content";
import { StateTransactionOperation } from "../state/service";
import type {
  InstallOpsServiceError,
  InstallOpsServiceShape,
} from "../install-ops/service";
import { BACKFILL_INLINE_MEDIA_V1 } from "../install-ops/engine";
import type {
  WorkContentProjectionKind,
  WorkContentProjectionRow,
  WorkContentProjections,
  WorkRepositoryError,
} from "../work/repository";
import type {
  ContentManifestError,
  ContentManifestShape,
  ContentOwner,
} from "./manifest";
import { ContentStoreError, ingestContentBytes } from "./store";

export type InlineMediaMigrationReport = {
  readonly status: "complete" | "already-complete";
  readonly objectsIngested: number;
  readonly rowsRewritten: number;
};

export class InlineMediaMigrationError extends Error {
  readonly _tag = "InlineMediaMigrationError";
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "InlineMediaMigrationError";
  }
}

const INLINE_KEYS = new Set(["bytesBase64", "dataBase64"]);
const PARTS_TARGETS: ReadonlyArray<
  readonly [WorkContentProjectionKind, string]
> = [
  ["message", "content.inline-media.rewrite.work_messages"],
  ["task-message", "content.inline-media.rewrite.work_task_messages"],
  ["artifact", "content.inline-media.rewrite.work_artifacts"],
  ["board-topic", "content.inline-media.rewrite.work_board_topics"],
  ["board-post", "content.inline-media.rewrite.work_board_posts"],
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasInlineBinary = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasInlineBinary);
  for (const [key, nested] of Object.entries(value)) {
    if (INLINE_KEYS.has(key)) return true;
    if (hasInlineBinary(nested)) return true;
  }
  return false;
};

const decodeBase64 = (encoded: string): Buffer => {
  const cleaned = encoded.replace(/\s+/g, "");
  if (cleaned.length === 0)
    throw new InlineMediaMigrationError("empty base64 payload");
  return Buffer.from(cleaned, "base64");
};

type PendingIngest = {
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly displayName?: string;
  readonly path: ReadonlyArray<string | number>;
};

const collectInlinePayloads = (
  value: unknown,
  path: ReadonlyArray<string | number> = [],
): PendingIngest[] => {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectInlinePayloads(entry, [...path, index]),
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of INLINE_KEYS) {
    const encoded = record[key];
    if (typeof encoded === "string") {
      const mediaType =
        typeof record.mediaType === "string" && record.mediaType.length > 0
          ? record.mediaType
          : "application/octet-stream";
      const displayName =
        typeof record.displayName === "string" && record.displayName.length > 0
          ? record.displayName
          : undefined;
      return [{ bytes: decodeBase64(encoded), mediaType, displayName, path }];
    }
  }
  const nested: PendingIngest[] = [];
  for (const [key, child] of Object.entries(record)) {
    nested.push(...collectInlinePayloads(child, [...path, key]));
  }
  return nested;
};

const setAtPath = (
  root: unknown,
  path: ReadonlyArray<string | number>,
  replacement: unknown,
): unknown => {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = root.slice();
    const index = Number(head);
    copy[index] = setAtPath(copy[index], rest, replacement);
    return copy;
  }
  if (isPlainObject(root)) {
    return {
      ...root,
      [String(head)]: setAtPath(root[String(head)], rest, replacement),
    };
  }
  throw new InlineMediaMigrationError(
    `cannot rewrite non-container at path ${path.join(".")}`,
  );
};

const ownerFor = (row: WorkContentProjectionRow): ContentOwner => {
  const base = { canvasName: row.canvasName, nodeId: row.nodeId };
  switch (row.kind) {
    case "message":
    case "task-message":
      return { ...base, kind: "message", recordId: row.messageId };
    case "artifact":
      return { ...base, kind: "artifact", recordId: row.artifactId };
    case "board-topic":
      return { ...base, kind: "board_topic", recordId: row.topicId };
    case "board-post":
      return { ...base, kind: "board_post", recordId: row.postId };
  }
};

type IngestedObject = { readonly ref: ContentRef; readonly verifiedAt: string };

const migrationError = (cause: unknown): InlineMediaMigrationError =>
  cause instanceof InlineMediaMigrationError
    ? cause
    : new InlineMediaMigrationError(
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      );

const externalizeInlineMedia = Effect.fn("externalizeInlineMedia")(function* (
  value: unknown,
  root: string,
) {
  const pending = yield* Effect.try({
    try: () => collectInlinePayloads(value),
    catch: migrationError,
  });
  if (pending.length === 0) return { value, changed: false, objects: [] };
  let next = value;
  const objects: IngestedObject[] = [];
  // Deepest paths first so parent index paths stay stable while rewriting.
  const ordered = [...pending].sort((a, b) => b.path.length - a.path.length);
  for (const item of ordered) {
    const ingested = yield* Effect.tryPromise({
      try: () =>
        ingestContentBytes({
          root,
          source: item.bytes,
          mediaType: item.mediaType,
          displayName: item.displayName,
        }),
      catch: (cause) =>
        cause instanceof ContentStoreError ? cause : migrationError(cause),
    });
    objects.push({ ref: ingested.ref, verifiedAt: ingested.verifiedAt });
    next = yield* Effect.try({
      try: () =>
        setAtPath(next, item.path, { kind: "content", ref: ingested.ref }),
      catch: migrationError,
    });
  }
  return { value: next, changed: true, objects };
});

/** The caller supplies the same SqlClient captured by both ledger services. */
export const runInlineMediaMigration = Effect.fn("runInlineMediaMigration")(
  function* (input: {
    readonly sql: SqlClient.SqlClient;
    readonly manifest: ContentManifestShape;
    readonly projections: WorkContentProjections["Service"];
    readonly root: string;
    readonly installOps: InstallOpsServiceShape;
  }): Effect.fn.Return<
    InlineMediaMigrationReport,
    | ContentStoreError
    | ContentManifestError
    | InlineMediaMigrationError
    | InstallOpsServiceError
    | WorkRepositoryError
    | SqlError.SqlError
  > {
    const { sql, manifest, projections, root, installOps } = input;
    const marker = yield* installOps.getBackfill(BACKFILL_INLINE_MEDIA_V1);
    if (marker?.status === "complete") {
      return {
        status: "already-complete",
        objectsIngested: marker.objectsIngested,
        rowsRewritten: 0,
      };
    }
    yield* installOps.ensurePending(BACKFILL_INLINE_MEDIA_V1);
    let objectsIngested = 0;
    let rowsRewritten = 0;
    for (const [kind, operation] of PARTS_TARGETS) {
      const candidates = (yield* projections.scan(kind)).filter((row) => {
        try {
          return hasInlineBinary(JSON.parse(row.partsJson));
        } catch {
          return false;
        }
      });
      for (const row of candidates) {
        const parsed = yield* Effect.try({
          try: () => JSON.parse(row.partsJson) as unknown,
          catch: migrationError,
        });
        const rewritten = yield* externalizeInlineMedia(parsed, root);
        if (!rewritten.changed) continue;
        const json = JSON.stringify(rewritten.value);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* projections.rewrite(row, json);
              for (const object of rewritten.objects) {
                yield* manifest.recordContentObject({
                  sha256: object.ref.sha256,
                  byteLength: object.ref.byteLength,
                  verifiedAt: object.verifiedAt,
                });
                yield* manifest.recordContentRef({
                  ref: object.ref,
                  owner: ownerFor(row),
                });
              }
            }),
          )
          .pipe(Effect.provideService(StateTransactionOperation, operation));
        objectsIngested += rewritten.objects.length;
        rowsRewritten += 1;
      }
    }
    yield* installOps.markComplete(BACKFILL_INLINE_MEDIA_V1, objectsIngested);
    return { status: "complete", objectsIngested, rowsRewritten };
  },
);
