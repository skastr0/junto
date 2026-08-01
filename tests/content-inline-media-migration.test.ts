import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  runInlineMediaMigration,
} from "../src/main/vellum/content/inline-media-migration";
import {
  contentObjectPath,
  contentStoreRoot,
} from "../src/main/vellum/content/paths";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";

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

const openEngine = async (dbPath: string) => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(dbPath));
  runtimes.push(runtime);
  const state = await runtime.runPromise(StateEngine);
  return { runtime, state };
};

/** 1×1 PNG — valid small binary for a historical RawPart. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("inline media migration", () => {
  it("rewrites parts_json base64 into ContentRef, records object, marks complete", async () => {
    const home = await tempRoot("vellum-inline-media-");
    const stateDir = join(home, ".vellum", "state");
    await mkdir(stateDir, { recursive: true });
    const dbPath = join(stateDir, "vellum.db");
    const contentRoot = contentStoreRoot(home);

    const { state } = await openEngine(dbPath);

    const boardParts = JSON.stringify([
      {
        kind: "raw",
        bytesBase64: TINY_PNG.toString("base64"),
        mediaType: "image/png",
      },
    ]);

    // work_board_topics has no FK to events — clean seed surface.
    await Effect.runPromise(
      state.transaction("seed.board-topic", (writer) => {
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
      }),
    );

    const digest = createHash("sha256").update(TINY_PNG).digest("hex");

    const report = await runInlineMediaMigration({
      state,
      root: contentRoot,
    });

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
      state.read("assert.marker", (reader) =>
        reader.get<{
          readonly status: string;
          readonly objects_ingested: number;
        }>(
          `SELECT status, objects_ingested FROM content_inline_media_migration WHERE singleton = 1`,
        ),
      ),
    );
    expect(marker?.status).toBe("complete");
    expect(Number(marker?.objects_ingested)).toBe(1);

    // Idempotent re-run.
    const again = await runInlineMediaMigration({
      state,
      root: contentRoot,
    });
    expect(again.status).toBe("already-complete");
    expect(again.rowsRewritten).toBe(0);
  });
});
