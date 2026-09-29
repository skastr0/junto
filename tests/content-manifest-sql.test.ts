import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { ContentRef } from "../src/shared/content";
import { ContentManifest } from "../src/main/junto/content/manifest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";

const withManifest = async <A, E>(body: Effect.Effect<A, E, ContentManifest | SqlClient.SqlClient>) => {
  const root = await mkdtemp(join(tmpdir(), "junto-manifest-sql-"));
  const runtime = ManagedRuntime.make(ContentManifest.layer.pipe(
    Layer.provideMerge(makeStateEngineLive(join(root, "junto.db"))),
  ));
  try {
    return await runtime.runPromise(body);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
};

const ref = Schema.decodeUnknownSync(ContentRef)({ sha256: "a".repeat(64), byteLength: 17, mediaType: "text/plain" });
const owner = { kind: "message" as const, canvasName: "main", nodeId: "mailbox", recordId: "message-7" };
const verifiedAt = "2026-01-02T03:04:05.000Z";

describe("ContentManifest SQL service", () => {
  it("joins the caller transaction, sees uncommitted writes, and rolls back all ledger rows", async () => {
    await withManifest(Effect.gen(function* () {
      const manifest = yield* ContentManifest;
      const sql = yield* SqlClient.SqlClient;
      const rolledBack = yield* sql.withTransaction(Effect.gen(function* () {
        yield* manifest.recordContentObject({ ...ref, verifiedAt });
        yield* manifest.recordContentRef({ ref, owner, refId: "ref-1" });
        expect((yield* manifest.manifestAvailability(ref)).state).toBe("verified");
        expect(yield* manifest.listReferencedContentDigests()).toEqual([{ sha256: ref.sha256, byteLength: 17 }]);
        return yield* Effect.fail("abort");
      })).pipe(Effect.flip);
      expect(rolledBack).toBe("abort");
      expect(yield* manifest.getContentObject(ref.sha256)).toBeUndefined();
      expect(yield* manifest.listContentRefsForObject(ref.sha256)).toEqual([]);
      expect(yield* sql`SELECT * FROM content_receipts`).toEqual([]);
    }));
  });

  it("preserves missing/order/conflict rules, receipt refresh, and transfer protection", async () => {
    await withManifest(Effect.gen(function* () {
      const manifest = yield* ContentManifest;
      const sql = yield* SqlClient.SqlClient;
      expect((yield* manifest.recordContentRef({ ref, owner }).pipe(Effect.flip)).code).toBe("order");
      expect((yield* manifest.manifestAvailability(ref)).state).toBe("missing");
      yield* sql.withTransaction(Effect.gen(function* () {
        expect(yield* manifest.recordContentObject({ ...ref, verifiedAt })).toEqual({ created: true });
        expect((yield* manifest.recordContentObject({ ...ref, byteLength: 18, verifiedAt }).pipe(Effect.flip)).code).toBe("conflict");
        expect(yield* manifest.recordContentObject({ ...ref, verifiedAt: "2026-01-03T00:00:00.000Z" })).toEqual({ created: false });
        yield* manifest.upsertContentTransfer({ ...ref, transferId: "transfer-1", direction: "inbound", state: "receiving" });
        expect((yield* manifest.deleteUnreferencedContentObject(ref.sha256).pipe(Effect.flip)).code).toBe("conflict");
        yield* manifest.upsertContentTransfer({ ...ref, transferId: "transfer-1", direction: "inbound", state: "complete" });
        expect(yield* manifest.listActiveTransferDigests()).toEqual([]);
        yield* manifest.recordContentRef({ ref, owner, refId: "ref-1", createdAt: verifiedAt });
        expect(yield* manifest.listContentRefsForObject(ref.sha256)).toEqual([{ refId: "ref-1", ref, owner, createdAt: verifiedAt }]);
        expect((yield* manifest.deleteUnreferencedContentObject(ref.sha256).pipe(Effect.flip)).code).toBe("conflict");
      }));
      expect(yield* manifest.manifestAvailability(ref)).toEqual({ ref, state: "verified", verifiedSha256: ref.sha256, verifiedByteLength: 17, verifiedAt: "2026-01-03T00:00:00.000Z" });
      expect(yield* manifest.listContentObjectsWithRefCounts()).toEqual([{ sha256: ref.sha256, byteLength: 17, createdAt: verifiedAt, verifiedAt, refCount: 1 }]);
    }));
  });

  it("reports malformed persisted rows as typed decode errors", async () => {
    await withManifest(Effect.gen(function* () {
      const manifest = yield* ContentManifest;
      const sql = yield* SqlClient.SqlClient;
      // Inject corruption in this disposable database only; normal DDL rejects it.
      yield* sql`PRAGMA ignore_check_constraints = ON`;
      yield* sql`INSERT INTO content_objects(sha256, byte_length, created_at, verified_at)
        VALUES (${ref.sha256}, ${17}, ${""}, ${verifiedAt})`;
      yield* sql`PRAGMA ignore_check_constraints = OFF`;
      const error = yield* manifest.getContentObject(ref.sha256).pipe(Effect.flip);
      expect(error._tag).toBe("ContentManifestError");
      expect(error.code).toBe("decode");
      expect(error.cause).toMatchObject({ _tag: "SchemaError" });
    }));
  });
});
