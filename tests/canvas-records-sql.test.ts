import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { CanvasRecords, CanvasRecordsLive } from "../src/main/junto/canvas/records";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { canvasBodySha256Of, intentSha256Of } from "../src/main/junto/canvas-intent-identity";

test("SQL canvas participants preserve order, identity and outer rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-canvas-records-"));
  const runtime = ManagedRuntime.make(CanvasRecordsLive.pipe(Layer.provideMerge(makeStateEngineLive(join(root, "junto.db")))));
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const records = yield* CanvasRecords;
      const sql = yield* SqlClient.SqlClient;
      const doc: CanvasDoc = { nodes: [
        { id: "z", type: "text", x: 7, y: -3, width: 130, height: 47, text: "first", color: "2", ether: { entity: { kind: "task", name: "first" } } },
        { id: "a", type: "file", x: 23, y: 91, width: 74, height: 36, file: "note.md", subpath: "#heading", ether: { entity: { kind: "task", name: "second" } } },
        { id: "m", type: "group", x: 0, y: 0, width: 500, height: 400, label: "region", backgroundStyle: "ratio" },
        { id: "b", type: "link", x: -77, y: 34, width: 90, height: 100, url: "https://example.com", ether: { entity: { kind: "task", name: "third" } } },
      ], edges: [
        { id: "z-edge", fromNode: "z", toNode: "a", fromSide: "right", toSide: "left", fromEnd: "none", toEnd: "arrow", label: "notes", ether: { verb: "feeds" } },
        { id: "a-edge", fromNode: "a", toNode: "b", color: "4", ether: { verb: "feeds" } },
      ] };
      const revisionSha256 = canvasBodySha256Of(serializeCanvas(doc));
      const intentSha256 = intentSha256Of(new Map([["alpha", { revisionSha256 }]]));
      const input = { canvasName: "alpha", doc, revisionSha256, modifiedAt: "2026-01-02T03:04:05.000Z" };
      const created = yield* sql.withTransaction(Effect.gen(function* () {
        const created = yield* records.persistCanvas(input);
        yield* records.writePortfolioHead({ generation: "1", intentSha256, at: input.modifiedAt });
        return created;
      }));
      expect(created.created).toBe(true);
      expect(yield* records.readRevision("alpha")).toBe(revisionSha256);
      expect(yield* records.readRevision("missing")).toBeUndefined();
      expect(yield* records.readRawCanvasDoc(created.canvasId)).toEqual(doc);
      const authority = yield* sql.withTransaction(records.readCommandCenterPortfolio());
      expect(authority.documents.get("alpha")?.body).toBe(serializeCanvas(doc));
      expect(authority.intentSha256).toBe(intentSha256);
      expect(authority.actorRefs).toEqual([]);
      const reused = yield* sql.withTransaction(records.persistCanvas(input));
      expect(reused).toEqual({ canvasId: created.canvasId, created: false });
      expect(yield* sql.withTransaction(Effect.gen(function* () {
        yield* records.wipeCanvasAuthority();
        expect(yield* records.readPortfolioHead()).toBeUndefined();
        return yield* Effect.fail("abort configuration");
      })).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: "abort configuration" });
      expect((yield* records.readPortfolioHead())?.generation).toBe("1");
      expect(yield* records.reconstructCanvasDoc(created.canvasId)).toEqual(doc);
      yield* sql.withTransaction(records.deleteCanvas("alpha"));
      expect(yield* records.readRevision("alpha")).toBeUndefined();
      expect(yield* records.readDocumentRows()).toEqual([]);
      expect(yield* sql`SELECT * FROM canvas_nodes`).toEqual([]);
      expect(yield* sql`SELECT * FROM canvas_edges`).toEqual([]);
    }));
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SQL authority rejects duplicate ids, invalid ether and mismatched revision hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-canvas-records-"));
  const runtime = ManagedRuntime.make(CanvasRecordsLive.pipe(Layer.provideMerge(makeStateEngineLive(join(root, "junto.db")))));
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const records = yield* CanvasRecords;
      const sql = yield* SqlClient.SqlClient;
      const node = { id: "n", type: "text" as const, x: 1, y: 2, width: 30, height: 40, text: "body" };
      const doc: CanvasDoc = { nodes: [node], edges: [] };
      const revisionSha256 = canvasBodySha256Of(serializeCanvas(doc));
      const input = { canvasName: "alpha", doc, revisionSha256, modifiedAt: "2026-01-02T03:04:05.000Z" };
      expect(yield* sql.withTransaction(records.persistCanvas({ ...input, doc: { nodes: [node, { ...node, text: "last" }], edges: [] } })).pipe(Effect.result))
        .toMatchObject({ _tag: "Failure", failure: { _tag: "CanvasError", message: expect.stringContaining("duplicate") } });
      expect(yield* records.readDocumentRows()).toEqual([]);
      const created = yield* sql.withTransaction(records.persistCanvas(input));
      yield* records.writePortfolioHead({ generation: "1", intentSha256: intentSha256Of(new Map([["alpha", { revisionSha256 }]])), at: input.modifiedAt });
      yield* sql`UPDATE canvas_nodes SET text_content = 'tampered' WHERE canvas_id = ${created.canvasId}`;
      expect(yield* sql.withTransaction(records.readStoredAuthority()).pipe(Effect.result))
        .toMatchObject({ _tag: "Failure", failure: { _tag: "CanvasError", message: expect.stringContaining("revision hash mismatch") } });
      // JSON validity is schema-enforced; semantic validity belongs to reconstruction.
      yield* sql`UPDATE canvas_nodes SET ether_json = '{"entity":{"kind":7,"name":"bad"}}' WHERE canvas_id = ${created.canvasId}`;
      expect(yield* records.reconstructCanvasDoc(created.canvasId).pipe(Effect.result))
        .toMatchObject({ _tag: "Failure", failure: { _tag: "CanvasError" } });
    }));
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
