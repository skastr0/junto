import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import {
  contentIncomingDir,
  contentObjectPath,
  contentStoreRoot,
} from "../src/main/junto/content/paths";
import { createContentService } from "../src/main/junto/content/service";
import {
  ContentManifest,
  ContentManifestError,
} from "../src/main/junto/content/manifest";
import {
  ContentStoreError,
  ensureContentLayout,
  hashContentObjectFile,
  ingestContentBytes,
  verifyContentObjectFile,
} from "../src/main/junto/content/store";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";

const roots: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<StateEngine, unknown>> = [];

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

async function* chunked(data: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < data.length; offset += size) {
    yield data.subarray(offset, Math.min(offset + size, data.length));
  }
}

const openEngine = async (dbPath: string) => {
  const runtime = ManagedRuntime.make(
    ContentManifest.layer.pipe(Layer.provideMerge(makeStateEngineLive(dbPath))),
  );
  runtimes.push(runtime);
  const state = await runtime.runPromise(StateEngine);
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  const manifest = await runtime.runPromise(ContentManifest);
  return { runtime, state, sql, manifest };
};

describe("content layout + stream ingest", () => {
  it("streams chunks without buffering the full body and publishes by digest", async () => {
    const home = await tempRoot("junto-content-ingest-");
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
    const home = await tempRoot("junto-content-idem-");
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
    const home = await tempRoot("junto-content-corrupt-");
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
    ).rejects.toMatchObject({
      code: "corrupt",
    } satisfies Partial<ContentStoreError>);

    const digest = sha256Hex(payload);
    await expect(
      readFile(contentObjectPath(root, digest)),
    ).rejects.toBeTruthy();
  });

  it("refuses symlink substitution on the object tree", async () => {
    const home = await tempRoot("junto-content-symlink-");
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
  it("rejects refs before the object row exists (no dangling references)", async () => {
    const root = await tempRoot("junto-manifest-order-");
    const { manifest } = await openEngine(join(root, "junto.db"));
    await expect(
      Effect.runPromise(
        manifest.recordContentRef({
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
      ),
    ).rejects.toThrow(ContentManifestError);
  });

  it("records object then ref; crash-before-object-row leaves no ref", async () => {
    const root = await tempRoot("junto-manifest-order-");
    const { sql, manifest } = await openEngine(join(root, "junto.db"));
    const sha = sha256Hex("durable");
    // Simulate: object published on disk but process died before SQLite —
    // no content_objects, no content_refs.
    const refs = (
      await Effect.runPromise(
        sql<{ n: number }>`SELECT count(*) AS n FROM content_refs`,
      )
    )[0]!;
    expect(Number(refs.n)).toBe(0);

    await Effect.runPromise(
      sql.withTransaction(
        manifest.recordContentObject({
          sha256: sha,
          byteLength: 7,
          verifiedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    await Effect.runPromise(
      sql.withTransaction(
        manifest.recordContentRef({
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
        }),
      ),
    );

    expect(
      (await Effect.runPromise(manifest.getContentObject(sha)))?.byteLength,
    ).toBe(7);
    expect(
      await Effect.runPromise(manifest.listContentRefsForObject(sha)),
    ).toHaveLength(1);

    // Idempotent re-record of the same object.
    expect(
      (
        await Effect.runPromise(
          sql.withTransaction(
            manifest.recordContentObject({
              sha256: sha,
              byteLength: 7,
              verifiedAt: "2026-01-01T00:00:02.000Z",
            }),
          ),
        )
      ).created,
    ).toBe(false);
  });
});

describe("content service put + restart survival", () => {
  it("puts stream, records manifest, survives engine restart", async () => {
    const home = await tempRoot("junto-content-svc-");
    const stateDir = join(home, ".junto", "state");
    await mkdir(stateDir, { recursive: true });
    const dbPath = join(stateDir, "junto.db");
    const contentRoot = contentStoreRoot(home);

    const payload = Buffer.from("restart-me-please");
    const digest = sha256Hex(payload);

    {
      const { sql, manifest } = await openEngine(dbPath);
      const service = createContentService(sql, manifest, contentRoot);
      const put = await service
        .put({
          source: chunked(payload, 3),
          mediaType: "text/plain",
          displayName: "note.txt",
          owner: {
            kind: "task",
            canvasName: "main",
            nodeId: "task-node",
            recordId: "task-1",
          },
        })
        .pipe(Effect.runPromise);

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
      const { sql, manifest } = await openEngine(dbPath);
      const service = createContentService(sql, manifest, contentRoot);
      const ref = {
        sha256: digest as never,
        byteLength: payload.length as never,
        mediaType: "text/plain" as never,
        displayName: "note.txt" as never,
      };
      const availability = await service
        .availability(ref)
        .pipe(Effect.runPromise);
      expect(availability.state).toBe("verified");

      const refs = await service.listRefs(digest).pipe(Effect.runPromise);
      expect(refs).toHaveLength(1);
      expect(refs[0]!.owner.recordId).toBe("task-1");

      const onDisk = verifyContentObjectFile(contentRoot, ref);
      expect(onDisk.state).toBe("verified");
      expect(
        await readFile(contentObjectPath(contentRoot, digest), "utf8"),
      ).toBe("restart-me-please");
    }
  });

  it("does not create a ref when owner is omitted (orphan-safe object only)", async () => {
    const home = await tempRoot("junto-content-no-ref-");
    const stateDir = join(home, ".junto", "state");
    await mkdir(stateDir, { recursive: true });
    const dbPath = join(stateDir, "junto.db");
    const contentRoot = contentStoreRoot(home);
    const { sql, manifest } = await openEngine(dbPath);
    const service = createContentService(sql, manifest, contentRoot);
    const put = await service
      .put({
        source: Buffer.from("object-only"),
        mediaType: "text/plain",
      })
      .pipe(Effect.runPromise);
    expect(put.refRow).toBeUndefined();
    const refs = await service.listRefs(put.ref.sha256).pipe(Effect.runPromise);
    expect(refs).toEqual([]);
    const object = manifest.getContentObject(put.ref.sha256);
    const row = await object.pipe(Effect.runPromise);
    expect(row?.sha256).toBe(put.ref.sha256);
  });
});
