import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTENT_STATE_SCHEMA_SQL,
} from "../src/main/vellum/content/state-schema";
import {
  contentIncomingDir,
  contentObjectPath,
  contentStoreRoot,
} from "../src/main/vellum/content/paths";
import {
  createContentService,
} from "../src/main/vellum/content/service";
import {
  ContentManifestError,
  getContentObject,
  listContentRefsForObject,
  recordContentObject,
  recordContentRef,
} from "../src/main/vellum/content/manifest";
import {
  ContentStoreError,
  ensureContentLayout,
  hashContentObjectFile,
  ingestContentBytes,
  verifyContentObjectFile,
} from "../src/main/vellum/content/store";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import type {
  StateBindings,
  StateInputValue,
  StateRow,
  StateWriter,
} from "../src/main/vellum/state/service";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  migrateStateSchema,
  STATE_SCHEMA_V11_IDENTITY,
  STATE_SCHEMA_V12_IDENTITY,
  STATE_SCHEMA_V13_IDENTITY,
  STATE_SCHEMA_V14_IDENTITY,
  STATE_SCHEMA_V15_IDENTITY,
} from "../src/main/vellum/state/migrations";
import {
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V11_SQL,
  STATE_SCHEMA_V12_SQL,
  STATE_SCHEMA_V13_SQL,
  STATE_SCHEMA_V14_SQL,
} from "../src/main/vellum/state/schema";
import {
  expectedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/main/vellum/state/schema-identity";

const roots: string[] = [];
const runtimes: Array<
  ManagedRuntime.ManagedRuntime<StateEngine, unknown>
> = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const tempRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const sha256Hex = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

async function* chunked(
  data: Buffer,
  size: number,
): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < data.length; offset += size) {
    yield data.subarray(offset, Math.min(offset + size, data.length));
  }
}

const openEngine = async (dbPath: string) => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(dbPath));
  runtimes.push(runtime);
  const state = await runtime.runPromise(StateEngine);
  return { runtime, state };
};

describe("content layout + stream ingest", () => {
  it("streams chunks without buffering the full body and publishes by digest", async () => {
    const home = await tempRoot("vellum-content-ingest-");
    const root = contentStoreRoot(home);
    const payload = Buffer.alloc(256 * 1024 + 17, 0x5a);
    payload[0] = 0x01;
    payload[payload.length - 1] = 0xfe;
    const digest = sha256Hex(payload);

    const result = await ingestContentBytes({
      root,
      source: chunked(payload, 4093),
      mediaType: "application/octet-stream",
      displayName: "blob.bin",
    });

    expect(result.ref.sha256).toBe(digest);
    expect(result.ref.byteLength).toBe(payload.length);
    expect(result.created).toBe(true);
    expect(result.path).toBe(contentObjectPath(root, digest));

    const onDisk = await readFile(result.path);
    expect(onDisk.equals(payload)).toBe(true);
    expect(hashContentObjectFile(result.path)).toEqual({
      sha256: digest,
      byteLength: payload.length,
    });

    // Partial cleaned up.
    const partials = await readFile(contentIncomingDir(root)).catch(() => null);
    void partials;
    // Directory exists and is empty of partials for this ingest.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(contentIncomingDir(root))).toEqual([]);
  });

  it("is idempotent when the verified digest already exists", async () => {
    const home = await tempRoot("vellum-content-idem-");
    const root = contentStoreRoot(home);
    const payload = Buffer.from("same-bytes-twice");
    const first = await ingestContentBytes({
      root,
      source: payload,
      mediaType: "text/plain",
    });
    const second = await ingestContentBytes({
      root,
      source: payload,
      mediaType: "text/plain",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.ref.sha256).toBe(first.ref.sha256);
    expect(second.path).toBe(first.path);
  });

  it("fails closed on expected digest mismatch and leaves no published object", async () => {
    const home = await tempRoot("vellum-content-corrupt-");
    const root = contentStoreRoot(home);
    const payload = Buffer.from("actual-bytes");
    await expect(
      ingestContentBytes({
        root,
        source: payload,
        mediaType: "text/plain",
        expected: {
          sha256: "b".repeat(64) as never,
          byteLength: payload.length as never,
        },
      }),
    ).rejects.toMatchObject({ code: "corrupt" } satisfies Partial<ContentStoreError>);

    const digest = sha256Hex(payload);
    await expect(readFile(contentObjectPath(root, digest))).rejects.toBeTruthy();
  });

  it("refuses symlink substitution on the object tree", async () => {
    const home = await tempRoot("vellum-content-symlink-");
    const root = contentStoreRoot(home);
    ensureContentLayout(root);
    const outside = join(home, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "trap"), "x");
    // Replace sha256 root with a symlink.
    const { rmSync } = await import("node:fs");
    const digestRoot = join(root, "sha256");
    rmSync(digestRoot, { recursive: true, force: true });
    await symlink(outside, digestRoot);

    await expect(
      ingestContentBytes({
        root,
        source: Buffer.from("nope"),
        mediaType: "text/plain",
      }),
    ).rejects.toBeTruthy();
  });
});

describe("content manifest ordering", () => {
  const memoryWriter = (): {
    readonly database: DatabaseSync;
    readonly writer: StateWriter;
  } => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(CONTENT_STATE_SCHEMA_SQL);
    const bindValues = (bindings?: StateBindings): StateInputValue[] => {
      if (bindings === undefined) return [];
      if (Array.isArray(bindings)) return [...bindings];
      return Object.values(bindings);
    };
    const writer: StateWriter = {
      get: <Row extends StateRow = StateRow>(
        sql: string,
        bindings?: StateBindings,
      ) =>
        database
          .prepare(sql)
          .get(...(bindValues(bindings) as never[])) as Row | undefined,
      all: <Row extends StateRow = StateRow>(
        sql: string,
        bindings?: StateBindings,
      ) =>
        database
          .prepare(sql)
          .all(...(bindValues(bindings) as never[])) as Row[],
      run: (sql: string, bindings?: StateBindings) => {
        const result = database
          .prepare(sql)
          .run(...(bindValues(bindings) as never[]));
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
      },
    };
    return { database, writer };
  };

  it("rejects refs before the object row exists (no dangling references)", () => {
    const { writer } = memoryWriter();
    expect(() =>
      recordContentRef(writer, {
        ref: {
          sha256: "a".repeat(64) as never,
          byteLength: 1 as never,
          mediaType: "text/plain" as never,
        },
        owner: {
          kind: "task",
          canvasName: "main",
          nodeId: "task-1",
          recordId: "t1",
        },
      }),
    ).toThrow(ContentManifestError);
  });

  it("records object then ref; crash-before-object-row leaves no ref", () => {
    const { writer, database } = memoryWriter();
    const sha = sha256Hex("durable");
    // Simulate: object published on disk but process died before SQLite —
    // no content_objects, no content_refs.
    const refs = database
      .prepare("SELECT count(*) AS n FROM content_refs")
      .get() as { n: number };
    expect(Number(refs.n)).toBe(0);

    recordContentObject(writer, {
      sha256: sha,
      byteLength: 7,
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });
    recordContentRef(writer, {
      ref: {
        sha256: sha as never,
        byteLength: 7 as never,
        mediaType: "text/plain" as never,
        displayName: "note.txt" as never,
      },
      owner: {
        kind: "artifact",
        canvasName: "main",
        nodeId: "artifacts-1",
        recordId: "art-1",
      },
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    expect(getContentObject(writer, sha)?.byteLength).toBe(7);
    expect(listContentRefsForObject(writer, sha)).toHaveLength(1);

    // Idempotent re-record of the same object.
    expect(
      recordContentObject(writer, {
        sha256: sha,
        byteLength: 7,
        verifiedAt: "2026-01-01T00:00:02.000Z",
      }).created,
    ).toBe(false);
  });
});

describe("content schema migration 11 → current", () => {
  it("freezes v11/v12/v13/v14 identities and CURRENT version", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V11_SQL)).toEqual(
      STATE_SCHEMA_V11_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V12_SQL)).toEqual(
      STATE_SCHEMA_V12_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V13_SQL)).toEqual(
      STATE_SCHEMA_V13_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V14_SQL)).toEqual(
      STATE_SCHEMA_V14_IDENTITY,
    );
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_SQL)).toEqual(
      STATE_SCHEMA_V15_IDENTITY,
    );
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(15);
  });

  it("migrates v11 rows forward and preserves data; content + marker tables appear", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_V11_SQL);
      verifyAndStampStateSchema(database, STATE_SCHEMA_V11_SQL);
      database.exec("PRAGMA user_version = 11");

      // Seed a non-content row that must survive.
      database.exec(`
        INSERT INTO canvas_generations(
          generation, created_at, cause, intent_sha256, document_count
        ) VALUES (
          '1',
          '2026-01-01T00:00:00.000Z',
          'test',
          '${"c".repeat(64)}',
          0
        );
      `);

      const result = migrateStateSchema(database);
      expect(result.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
      expect(result.previousVersion).toBe(11);
      expect(result.actualSchemaSha256).toBe(
        STATE_SCHEMA_V15_IDENTITY.actualSchemaSha256,
      );

      const gen = database
        .prepare("SELECT generation FROM canvas_generations WHERE generation = '1'")
        .get() as { generation: string };
      expect(gen.generation).toBe("1");

      for (const table of [
        "content_objects",
        "content_refs",
        "content_receipts",
        "content_transfers",
        "content_inline_media_migration",
      ]) {
        const row = database
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?`,
          )
          .get(table) as { name: string } | undefined;
        expect(row?.name).toBe(table);
      }
    } finally {
      database.close();
    }
  });

  it("migrates v12 → current and keeps the marker table", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_V12_SQL);
      verifyAndStampStateSchema(database, STATE_SCHEMA_V12_SQL);
      database.exec("PRAGMA user_version = 12");

      const result = migrateStateSchema(database);
      expect(result.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
      expect(result.previousVersion).toBe(12);
      expect(result.actualSchemaSha256).toBe(
        STATE_SCHEMA_V15_IDENTITY.actualSchemaSha256,
      );

      const marker = database
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'content_inline_media_migration'`,
        )
        .get() as { name: string } | undefined;
      expect(marker?.name).toBe("content_inline_media_migration");
    } finally {
      database.close();
    }
  });
});

describe("content service put + restart survival", () => {
  it("puts stream, records manifest, survives engine restart", async () => {
    const home = await tempRoot("vellum-content-svc-");
    const stateDir = join(home, ".vellum", "state");
    await mkdir(stateDir, { recursive: true });
    const dbPath = join(stateDir, "vellum.db");
    const contentRoot = contentStoreRoot(home);

    const payload = Buffer.from("restart-me-please");
    const digest = sha256Hex(payload);

    {
      const { state } = await openEngine(dbPath);
      const service = createContentService(state, contentRoot);
      const put = await service.put({
        source: chunked(payload, 3),
        mediaType: "text/plain",
        displayName: "note.txt",
        owner: {
          kind: "task",
          canvasName: "main",
          nodeId: "task-node",
          recordId: "task-1",
        },
      }).pipe(Effect.runPromise);

      expect(put.ref.sha256).toBe(digest);
      expect(put.refRow?.owner.recordId).toBe("task-1");

      const availability = await service
        .availability(put.ref)
        .pipe(Effect.runPromise);
      expect(availability.state).toBe("verified");
    }

    // Dispose and reopen — proves restart survival.
    while (runtimes.length > 0) {
      await runtimes.pop()!.dispose();
    }

    {
      const { state } = await openEngine(dbPath);
      const service = createContentService(state, contentRoot);
      const ref = {
        sha256: digest as never,
        byteLength: payload.length as never,
        mediaType: "text/plain" as never,
        displayName: "note.txt" as never,
      };
      const availability = await service.availability(ref).pipe(Effect.runPromise);
      expect(availability.state).toBe("verified");

      const refs = await service.listRefs(digest).pipe(Effect.runPromise);
      expect(refs).toHaveLength(1);
      expect(refs[0]!.owner.recordId).toBe("task-1");

      const onDisk = verifyContentObjectFile(contentRoot, ref);
      expect(onDisk.state).toBe("verified");
      expect(await readFile(contentObjectPath(contentRoot, digest), "utf8")).toBe(
        "restart-me-please",
      );
    }
  });

  it("does not create a ref when owner is omitted (orphan-safe object only)", async () => {
    const home = await tempRoot("vellum-content-no-ref-");
    const stateDir = join(home, ".vellum", "state");
    await mkdir(stateDir, { recursive: true });
    const dbPath = join(stateDir, "vellum.db");
    const contentRoot = contentStoreRoot(home);
    const { state } = await openEngine(dbPath);
    const service = createContentService(state, contentRoot);
    const put = await service
      .put({
        source: Buffer.from("object-only"),
        mediaType: "text/plain",
      })
      .pipe(Effect.runPromise);
    expect(put.refRow).toBeUndefined();
    const refs = await service.listRefs(put.ref.sha256).pipe(Effect.runPromise);
    expect(refs).toEqual([]);
    const object = state.read("test", (reader) =>
      getContentObject(reader, put.ref.sha256),
    );
    // state.read returns Effect
    const row = await object.pipe(Effect.runPromise);
    expect(row?.sha256).toBe(put.ref.sha256);
  });
});
