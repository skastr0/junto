/**
 * A rename through Junto carries the threads on what moved (0.11, F7): the
 * rule, proven where it is decided — the subject a row keeps once its file
 * has a new path. The store walk that applies it is `carryFileThreads`, and
 * the files service calls it after the filesystem change (`bb53be3a4`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { carriedPath, carriedSubject, carryFileThreads, pathUnder } from "../src/main/junto/work/file-thread-paths";
import { unjournaledWorkMutationEffect } from "../src/main/junto/work/mutation-seam";
import { threadSubjectOf } from "../src/shared/thread-subject";

const NODE = "files-1";
const OTHER = "files-2";

const row = (subject: unknown): Readonly<Record<string, unknown>> => ({ factoryMail: true, threadSubject: subject });

describe("the path a move carries", () => {
  it("moves what is under the old path, and only that", () => {
    expect(pathUnder("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathUnder("src/dir/b.ts", "src/dir")).toBe(true);
    expect(pathUnder("src/dir", "src")).toBe(true);
    expect(pathUnder("src/dirx/b.ts", "src/dir")).toBe(false);
    expect(pathUnder("other/b.ts", "src/dir")).toBe(false);
    expect(carriedPath("src/a.ts", "src/a.ts", "src/b.ts")).toBe("src/b.ts");
    expect(carriedPath("src/dir/b.ts", "src/dir", "src/moved")).toBe("src/moved/b.ts");
  });
});

describe("a rename's thread carry", () => {
  it("carries a file subject's path, and the path its lines anchor names", () => {
    const carried = carriedSubject(
      row({ kind: "file", nodeId: NODE, path: "src/a.ts", anchor: { kind: "lines", file: "src/a.ts", from: 3, to: 4, quote: "x" } }),
      NODE,
      "src/a.ts",
      "src/b.ts",
    );
    expect(carried).toBeDefined();
    expect(threadSubjectOf({ metadata: carried })).toEqual({
      kind: "file",
      nodeId: NODE,
      path: "src/b.ts",
      anchor: { kind: "lines", file: "src/b.ts", from: 3, to: 4, quote: "x" },
    });
  });

  it("carries a folder's threads, and leaves a box anchor's page alone", () => {
    const carried = carriedSubject(
      row({ kind: "file", nodeId: NODE, path: "docs/brief.pdf", anchor: { kind: "pageBox", page: 2, x: 0, y: 0, w: 0.5, h: 0.5 } }),
      NODE,
      "docs",
      "papers",
    );
    expect(threadSubjectOf({ metadata: carried })).toEqual({
      kind: "file",
      nodeId: NODE,
      path: "papers/brief.pdf",
      anchor: { kind: "pageBox", page: 2, x: 0, y: 0, w: 0.5, h: 0.5 },
    });
  });

  it("leaves every row that is not that file's: another node, another file, another subject", () => {
    const file = { kind: "file", nodeId: NODE, path: "src/a.ts" };
    expect(carriedSubject(row(file), OTHER, "src/a.ts", "src/b.ts")).toBeUndefined();
    expect(carriedSubject(row(file), NODE, "src/other.ts", "src/b.ts")).toBeUndefined();
    expect(carriedSubject(row({ kind: "task", nodeId: NODE, taskId: "01M5ESKX20QX0HA3Y6SHEPXBCX" }), NODE, "src/a.ts", "src/b.ts")).toBeUndefined();
    expect(carriedSubject(row({ kind: "page", nodeId: NODE }), NODE, "src/a.ts", "src/b.ts")).toBeUndefined();
    expect(carriedSubject({ factoryMail: true }, NODE, "src/a.ts", "src/b.ts")).toBeUndefined();
  });

  it("refuses a carried path a subject may not name", () => {
    // A move whose new name would leave the root: the row keeps its own path
    // rather than the carry writing a subject that cannot decode.
    expect(carriedSubject(row({ kind: "file", nodeId: NODE, path: "a.ts" }), NODE, "a.ts", "../a.ts")).toBeUndefined();
  });
});

/**
 * The store walk itself, on the real engine: two rows of the node, one on the
 * file that moved and one on a neighbour, plus a row of another node; after
 * the carry the first names the new path and the others are untouched.
 */
const SEAT = `seat_${"a".repeat(64)}`;
const NOW = "2026-01-01T00:00:00.000Z";

/** Two mail rows on the node and one on another, each behind its own fact so every key holds. */
const seedRows = (sql: SqlClient.SqlClient, rows: ReadonlyArray<readonly [node: string, messageId: string, subject: unknown]>) =>
  sql.withTransaction(
    unjournaledWorkMutationEffect(
      "test.fixture-seed",
      Effect.gen(function* () {
        yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES ('home1', ${NOW})`;
        yield* sql`INSERT INTO work_event_sequences(event_home, entity_home, last_seq) VALUES ('home1', 'home1', ${String(rows.length)})`;
        for (const [index, [node, messageId, subject]] of rows.entries()) {
          const seq = String(index + 1);
          yield* sql`INSERT INTO work_events(
              event_home, entity_home, seq, protocol, record_type, item_kind, item_id,
              item_canvas_name, item_node_id, operation, content_sha256, origin_at, received_at
            ) VALUES ('home1', 'home1', ${seq}, 'junto/work/v1', 'fact', 'message', ${messageId},
              'factory', ${node}, 'message.append', ${"a".repeat(64)}, ${NOW}, ${NOW})`;
          yield* sql`INSERT INTO work_facts(event_home, entity_home, seq, result_json, basis_kind)
            VALUES ('home1', 'home1', ${seq}, '{}', 'historical')`;
          yield* sql`INSERT INTO work_messages(
              canvas_name, node_id, message_id, position, entity_home, actor_seat_id,
              fact_event_home, fact_entity_home, fact_seq, role, parts_json, metadata_json, origin_at, received_at
            ) VALUES ('factory', ${node}, ${messageId}, ${index}, 'home1', ${SEAT},
              'home1', 'home1', ${seq}, 'agent', '[]', ${JSON.stringify({ factoryMail: true, threadSubject: subject })}, ${NOW}, ${NOW})`;
        }
      }),
    ),
  );

describe("the carry in the store", () => {
  it("moves the moved file's rows, leaves the neighbour's and the other node's, and reads back as a subject", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-file-thread-paths-"));
    const runtime = ManagedRuntime.make(makeStateEngineLive(join(root, "junto.db")));
    try {
      const sql = await runtime.runPromise(SqlClient.SqlClient);
      await runtime.runPromise(
        seedRows(sql, [
          ["files-1", "m1", { kind: "file", nodeId: "files-1", path: "src/a.ts", anchor: { kind: "lines", file: "src/a.ts", from: 1, to: 1, quote: "x" } }],
          ["files-1", "m2", { kind: "file", nodeId: "files-1", path: "src/other.ts" }],
          ["files-2", "m3", { kind: "file", nodeId: "files-2", path: "src/a.ts" }],
        ]),
      );
      const moved = await runtime.runPromise(carryFileThreads(sql, "factory", "files-1", "src/a.ts", "src/b.ts"));
      expect(moved).toBe(1);
      const rows = await runtime.runPromise(
        sql.unsafe<{ message_id: string; metadata_json: string }>(
          "SELECT message_id, metadata_json FROM work_messages ORDER BY message_id",
          [],
        ),
      );
      const subject = (id: string) => threadSubjectOf({ metadata: JSON.parse(rows.find((row) => row.message_id === id)!.metadata_json) as Record<string, unknown> });
      expect(subject("m1")).toEqual({
        kind: "file",
        nodeId: "files-1",
        path: "src/b.ts",
        anchor: { kind: "lines", file: "src/b.ts", from: 1, to: 1, quote: "x" },
      });
      expect(subject("m2")).toEqual({ kind: "file", nodeId: "files-1", path: "src/other.ts" });
      expect(subject("m3")).toEqual({ kind: "file", nodeId: "files-2", path: "src/a.ts" });
      // A second carry of the same move finds nothing: the rows are already there.
      expect(await runtime.runPromise(carryFileThreads(sql, "factory", "files-1", "src/a.ts", "src/b.ts"))).toBe(0);
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
