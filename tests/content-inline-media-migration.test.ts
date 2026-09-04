import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  runInlineMediaMigration,
} from "../src/main/vellum/content/inline-media-migration";
import { unjournaledWorkMutation } from "../src/main/vellum/work/mutation-seam";
import {
  contentObjectPath,
  contentStoreRoot,
} from "../src/main/vellum/content/paths";
import {
  BACKFILL_INLINE_MEDIA_V1,
  InstallOpsService,
  makeInstallOpsLive,
} from "../src/main/vellum/install-ops/engine";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";

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
  const stateDir = join(home, ".vellum-command", "state");
  await mkdir(stateDir, { recursive: true });
  const dbPath = join(stateDir, "vellum-command.db");
  const opsPath = join(stateDir, "install-ops.db");
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeStateEngineLive(dbPath),
      makeInstallOpsLive(opsPath),
    ),
  );
  runtimes.push(runtime);
  const state = await runtime.runPromise(StateEngine);
  const installOps = await runtime.runPromise(InstallOpsService);
  return { runtime, state, installOps, contentRoot: contentStoreRoot(home) };
};

/** 1×1 PNG — valid small binary for a historical RawPart. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("inline media migration", () => {
  it("rewrites parts_json base64 into ContentRef, records object, marks complete", async () => {
    const home = await tempRoot("vellum-inline-media-");
    const { state, installOps, contentRoot } = await openEngines(home);

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
      state.transaction("seed.board-topic", (writer) => {
        unjournaledWorkMutation("test.fixture-seed", () => {
          writer.run(
            `
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
            [
              "main",
              "board-1",
              "topic-1",
              "legacy media",
              "open",
              "operator",
              boardParts,
              0,
              "2026-01-01T00:00:00.000Z",
              "2026-01-01T00:00:00.000Z",
              "2026-01-01T00:00:00.000Z",
            ],
          );
        });
      }),
    );

    const digest = createHash("sha256").update(TINY_PNG).digest("hex");

    const report = await Effect.runPromise(
      runInlineMediaMigration({
        state,
        root: contentRoot,
        installOps,
      }),
    );

    expect(report.status).toBe("complete");
    expect(report.objectsIngested).toBe(1);
    expect(report.rowsRewritten).toBe(1);

    const row = await Effect.runPromise(
      state.read("assert.parts", (reader) =>
        reader.get<{ readonly parts_json: string }>(
          `
            SELECT parts_json FROM work_board_topics
            WHERE canvas_name = ? AND node_id = ? AND topic_id = ?
          `,
          ["main", "board-1", "topic-1"],
        ),
      ),
    );
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

    const object = await Effect.runPromise(
      state.read("assert.object", (reader) =>
        reader.get<{ readonly sha256: string; readonly byte_length: number }>(
          `SELECT sha256, byte_length FROM content_objects WHERE sha256 = ?`,
          [digest],
        ),
      ),
    );
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
        state,
        root: contentRoot,
        installOps,
      }),
    );
    expect(again.status).toBe("already-complete");
    expect(again.rowsRewritten).toBe(0);
  });

  it("completes against immutable work logs and leaves them byte-identical", async () => {
    const home = await tempRoot("vellum-inline-media-logs-");
    const { state, installOps, contentRoot } = await openEngines(home);

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
      state.transaction("seed.immutable-logs", (writer) => {
        writer.run(
          `
            INSERT INTO station_known_installations(
              installation_id, registered_at
            ) VALUES (?, ?)
          `,
          ["home1", now],
        );
        writer.run(
          `
            INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
            VALUES (?, ?, ?)
          `,
          ["home1", "home1", "2"],
        );
        writer.run(
          `
            INSERT INTO work_events(
              event_home, entity_home, seq, protocol, record_type,
              item_kind, item_id, item_canvas_name, item_node_id,
              operation, content_sha256, origin_at, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            "home1",
            "home1",
            "1",
            "vellum/work/v2",
            "fact",
            "message",
            "msg-1",
            "main",
            "node-1",
            "message.append",
            sha,
            now,
            now,
          ],
        );
        writer.run(
          `
            INSERT INTO station_projection_versions(
              generation, content_sha256, source_canvas_generation,
              source_intent_sha256, body, created_at, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          ["1", sha, "1", sha, "{}", now, now],
        );
        writer.run(
          `
            INSERT INTO work_facts(
              event_home, entity_home, seq, result_json,
              basis_kind, basis_projected_generation,
              basis_projected_content_sha256
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          ["home1", "home1", "1", factBody, "projected-intent", "1", sha],
        );
      }),
    );

    const report = await Effect.runPromise(
      runInlineMediaMigration({
        state,
        root: contentRoot,
        installOps,
      }),
    );

    // The walk completes — historical logs are out of scope, not an abort.
    expect(report.status).toBe("complete");
    expect(report.rowsRewritten).toBe(0);

    const rows = await Effect.runPromise(
      state.read("assert.logs-untouched", (reader) => ({
        fact: reader.get<{ readonly result_json: string }>(
          `
            SELECT result_json FROM work_facts
            WHERE event_home = ? AND entity_home = ? AND seq = ?
          `,
          ["home1", "home1", "1"],
        ),
        event: reader.get<{ readonly content_sha256: string }>(
          `
            SELECT content_sha256 FROM work_events
            WHERE event_home = ? AND entity_home = ? AND seq = ?
          `,
          ["home1", "home1", "1"],
        ),
      })),
    );
    expect(rows.fact?.result_json).toBe(factBody);
    expect(rows.event?.content_sha256).toBe(sha);

    const marker = await Effect.runPromise(
      installOps.getBackfill(BACKFILL_INLINE_MEDIA_V1),
    );
    expect(marker?.status).toBe("complete");
  });
});
