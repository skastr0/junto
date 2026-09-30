import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentManifest,
  ContentManifestError,
} from "../src/main/junto/content/manifest";
import {
  WorkContentProjections,
  WorkContentProjectionsLive,
} from "../src/main/junto/work/repository";
import { runInlineMediaMigration } from "../src/main/junto/content/inline-media-migration";
import { unjournaledWorkMutationEffect } from "../src/main/junto/work/mutation-seam";
import {
  contentObjectPath,
  contentStoreRoot,
} from "../src/main/junto/content/paths";
import {
  BACKFILL_INLINE_MEDIA_V1,
  InstallOpsService,
  makeInstallOpsLive,
} from "../src/main/junto/install-ops/engine";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { OverseerLiveExecution } from "../src/main/junto/overseer/live/execution";

const roots: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<any, unknown>> = [];

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

const openEngines = async (home: string) => {
  const stateDir = join(home, ".junto", "state");
  await mkdir(stateDir, { recursive: true });
  const dbPath = join(stateDir, "junto.db");
  const opsPath = join(stateDir, "install-ops.db");
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(ContentManifest.layer, WorkContentProjectionsLive).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          makeStateEngineLive(dbPath),
          makeInstallOpsLive(opsPath),
        ),
      ),
    ),
  );
  runtimes.push(runtime);
  const installOps = await runtime.runPromise(InstallOpsService);
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  const manifest = await runtime.runPromise(ContentManifest);
  const projections = await runtime.runPromise(WorkContentProjections);
  return {
    runtime,
    installOps,
    sql,
    manifest,
    projections,
    contentRoot: contentStoreRoot(home),
  };
};

/** 1×1 PNG — valid small binary for a historical RawPart. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("inline media migration", () => {
  it("rewrites parts_json base64 into ContentRef, records object, marks complete", async () => {
    const home = await tempRoot("junto-inline-media-");
    const { installOps, sql, manifest, projections, contentRoot } =
      await openEngines(home);

    const boardParts = JSON.stringify([
      {
        kind: "raw",
        bytesBase64: TINY_PNG.toString("base64"),
        mediaType: "image/png",
      },
    ]);

    // work_board_topics has no FK to events — clean seed surface.
    // Declared journal-free: this fixture must pin how an OLD projection row
    // survives the backfill, so it seeds the row shape directly rather than
    // going through the repository's current write path.
    await Effect.runPromise(
      sql.withTransaction(
        unjournaledWorkMutationEffect(
          "test.fixture-seed",
          sql`
            INSERT INTO work_board_topics(
              canvas_name,
              node_id,
              topic_id,
              title,
              state,
              author_kind,
              parts_json,
              post_count,
              last_activity_at,
              created_at,
              updated_at
            ) VALUES ('main', 'board-1', 'topic-1', 'legacy media', 'open', 'operator',
              ${boardParts}, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
          `,
        ),
      ),
    );

    const digest = createHash("sha256").update(TINY_PNG).digest("hex");

    const operations: string[] = [];
    const report = await Effect.runPromise(
      runInlineMediaMigration({
        sql,
        manifest,
        projections,
        root: contentRoot,
        installOps,
      }).pipe(
        Effect.provideService(OverseerLiveExecution, {
          assertCurrent: () => undefined,
          assertCurrentWithin: Effect.void,
          afterMutation: (operation) =>
            Effect.sync(() => {
              operations.push(operation);
            }),
        }),
      ),
    );

    expect(operations).toEqual([
      "content.inline-media.rewrite.work_board_topics",
    ]);
    expect(report.status).toBe("complete");
    expect(report.objectsIngested).toBe(1);
    expect(report.rowsRewritten).toBe(1);

    const row = (
      await Effect.runPromise(
        sql<{ readonly parts_json: string }>`
            SELECT parts_json FROM work_board_topics
            WHERE canvas_name = 'main' AND node_id = 'board-1' AND topic_id = 'topic-1'
          `,
      )
    )[0];
    expect(row).toBeDefined();
    const parts = JSON.parse(row!.parts_json) as unknown;
    expect(JSON.stringify(parts)).not.toContain("bytesBase64");
    expect(parts).toEqual([
      {
        kind: "content",
        ref: {
          sha256: digest,
          byteLength: TINY_PNG.byteLength,
          mediaType: "image/png",
        },
      },
    ]);

    await access(contentObjectPath(contentRoot, digest));

    const object = (
      await Effect.runPromise(
        sql<{
          readonly sha256: string;
          readonly byte_length: number;
        }>`SELECT sha256, byte_length FROM content_objects WHERE sha256 = ${digest}`,
      )
    )[0];
    expect(object?.sha256).toBe(digest);
    expect(Number(object?.byte_length)).toBe(TINY_PNG.byteLength);

    const marker = await Effect.runPromise(
      installOps.getBackfill(BACKFILL_INLINE_MEDIA_V1),
    );
    expect(marker?.status).toBe("complete");
    expect(marker?.objectsIngested).toBe(1);

    // Idempotent re-run.
    const again = await Effect.runPromise(
      runInlineMediaMigration({
        sql,
        manifest,
        projections,
        root: contentRoot,
        installOps,
      }),
    );
    expect(again.status).toBe("already-complete");
    expect(again.rowsRewritten).toBe(0);
  });

  it("completes against immutable work logs and leaves them byte-identical", async () => {
    const home = await tempRoot("junto-inline-media-logs-");
    const { installOps, sql, manifest, projections, contentRoot } =
      await openEngines(home);

    const factBody = JSON.stringify({
      parts: [
        {
          kind: "raw",
          bytesBase64: TINY_PNG.toString("base64"),
          mediaType: "image/png",
        },
      ],
    });
    const sha = "a".repeat(64);
    const now = "2026-01-01T00:00:00.000Z";

    // Historical fact with inline Base64, seeded against the REAL schema —
    // immutability triggers active. This is the exact shape that must never
    // abort the migration.
    await Effect.runPromise(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO station_known_installations(
              installation_id, registered_at
            ) VALUES ('home1', ${now})
          `;
          yield* sql`
            INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
            VALUES ('home1', 'home1', '2')
          `;
          yield* sql`
            INSERT INTO work_events(
              event_home, entity_home, seq, protocol, record_type,
              item_kind, item_id, item_canvas_name, item_node_id,
              operation, content_sha256, origin_at, received_at
            ) VALUES ('home1', 'home1', '1', 'junto/work/v1', 'fact', 'message',
              'msg-1', 'main', 'node-1', 'message.append', ${sha}, ${now}, ${now})
          `;
          yield* sql`
            INSERT INTO station_projection_versions(
              generation, content_sha256, source_canvas_generation,
              source_intent_sha256, body, created_at, received_at
            ) VALUES ('1', ${sha}, '1', ${sha}, '{}', ${now}, ${now})
          `;
          yield* sql`
            INSERT INTO work_facts(
              event_home, entity_home, seq, result_json,
              basis_kind, basis_projected_generation,
              basis_projected_content_sha256
            ) VALUES ('home1', 'home1', '1', ${factBody}, 'projected-intent', '1', ${sha})
          `;
        }),
      ),
    );

    const report = await Effect.runPromise(
      runInlineMediaMigration({
        sql,
        manifest,
        projections,
        root: contentRoot,
        installOps,
      }),
    );

    // The walk completes — historical logs are out of scope, not an abort.
    expect(report.status).toBe("complete");
    expect(report.rowsRewritten).toBe(0);

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        return {
          fact: (yield* sql<{ readonly result_json: string }>`
            SELECT result_json FROM work_facts
            WHERE event_home = 'home1' AND entity_home = 'home1' AND seq = '1'
          `)[0],
          event: (yield* sql<{ readonly content_sha256: string }>`
            SELECT content_sha256 FROM work_events
            WHERE event_home = 'home1' AND entity_home = 'home1' AND seq = '1'
          `)[0],
        };
      }),
    );
    expect(rows.fact?.result_json).toBe(factBody);
    expect(rows.event?.content_sha256).toBe(sha);

    const marker = await Effect.runPromise(
      installOps.getBackfill(BACKFILL_INLINE_MEDIA_V1),
    );
    expect(marker?.status).toBe("complete");
  });

  it("rolls back the failed row with its manifest and resumes without replaying committed rows", async () => {
    const home = await tempRoot("junto-inline-media-resume-");
    const { sql, manifest, projections, installOps, contentRoot } =
      await openEngines(home);
    const firstBytes = Buffer.from("first projection");
    const secondBytes = Buffer.from("second projection with different bytes");
    const firstDigest = createHash("sha256").update(firstBytes).digest("hex");
    const secondDigest = createHash("sha256").update(secondBytes).digest("hex");
    const inline = (bytes: Buffer) =>
      JSON.stringify([
        {
          kind: "raw",
          mediaType: "text/plain",
          bytesBase64: bytes.toString("base64"),
        },
      ]);
    await Effect.runPromise(
      sql.withTransaction(
        unjournaledWorkMutationEffect(
          "test.fixture-seed",
          Effect.gen(function* () {
            for (const [topicId, bytes] of [
              ["topic-a", firstBytes],
              ["topic-b", secondBytes],
            ] as const) {
              yield* sql`INSERT INTO work_board_topics(
          canvas_name, node_id, topic_id, title, state, author_kind, parts_json,
          post_count, last_activity_at, created_at, updated_at
        ) VALUES ('main', 'board', ${topicId}, 'historical', 'open', 'operator', ${inline(bytes)},
          0, '2026-01-01', '2026-01-01', '2026-01-01')`;
            }
            yield* sql`CREATE TEMP TRIGGER fail_second_ref BEFORE INSERT ON content_refs
        WHEN NEW.owner_record_id = 'topic-b' BEGIN SELECT RAISE(ABORT, 'injected ref failure'); END`;
          }),
        ),
      ),
    );

    const run = () =>
      runInlineMediaMigration({
        sql,
        manifest,
        projections,
        installOps,
        root: contentRoot,
      });
    await expect(Effect.runPromise(run())).rejects.toBeInstanceOf(
      ContentManifestError,
    );
    expect(
      (
        await Effect.runPromise(
          installOps.getBackfill(BACKFILL_INLINE_MEDIA_V1),
        )
      )?.status,
    ).toBe("pending");
    const partial = await Effect.runPromise(sql<{
      topic_id: string;
      parts_json: string;
    }>`
      SELECT topic_id, parts_json FROM work_board_topics ORDER BY topic_id`);
    expect(partial.map((row) => row.topic_id)).toEqual(["topic-a", "topic-b"]);
    expect(JSON.parse(partial[0]!.parts_json)).toEqual([
      {
        kind: "content",
        ref: {
          sha256: firstDigest,
          byteLength: firstBytes.length,
          mediaType: "text/plain",
        },
      },
    ]);
    expect(partial[1]!.parts_json).toBe(inline(secondBytes));
    expect(
      await Effect.runPromise(manifest.listContentRefsForObject(firstDigest)),
    ).toHaveLength(1);
    expect(
      await Effect.runPromise(manifest.getContentObject(secondDigest)),
    ).toBeUndefined();
    expect(
      await Effect.runPromise(manifest.listContentRefsForObject(secondDigest)),
    ).toEqual([]);
    await access(contentObjectPath(contentRoot, secondDigest));

    await Effect.runPromise(sql`DROP TRIGGER fail_second_ref`);
    expect(await Effect.runPromise(run())).toEqual({
      status: "complete",
      objectsIngested: 1,
      rowsRewritten: 1,
    });
    expect(
      await Effect.runPromise(manifest.listContentRefsForObject(firstDigest)),
    ).toHaveLength(1);
    expect(
      await Effect.runPromise(manifest.listContentRefsForObject(secondDigest)),
    ).toHaveLength(1);
    expect(
      (
        await Effect.runPromise(
          installOps.getBackfill(BACKFILL_INLINE_MEDIA_V1),
        )
      )?.status,
    ).toBe("complete");
  });
});
