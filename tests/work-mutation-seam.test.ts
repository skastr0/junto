/**
 * The single work mutation seam is the only route into the work plane.
 *
 * These pin the INVARIANT, not an implementation shape: a materialized work
 * row may exist only because a journal record in the same transaction explains
 * it, or because a declared journal-free reason says it deliberately does not.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import type { StateEngineShape } from "../src/main/junto/state/service";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import {
  CANVAS_REVISION_TABLES,
  UNJOURNALED_WORK_REASONS,
  beginWorkMutationScope,
  WORK_PLANE_TABLE_ROLES,
  classifyWorkStatement,
  workStatementSinkParams,
  unjournaledWorkMutation,
  workMutationScopeForTest,
  type WorkPlaneTableRole,
} from "../src/main/junto/work/mutation-seam";

const root = join(tmpdir(), `junto-seam-${randomUUID()}`);
const runtime = ManagedRuntime.make(
  Layer.mergeAll(makeStateEngineLive(join(root, "junto.db"))),
);

let state: StateEngineShape;

const HOME = "seam-home";
const SHA = "a".repeat(64);
const NOW = "2026-01-01T00:00:00.000Z";

beforeAll(async () => {
  state = await runtime.runPromise(StateEngine);
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const failure = async (
  operation: string,
  body: (writer: {
    readonly run: (sql: string, bindings?: ReadonlyArray<never>) => unknown;
  }) => unknown,
): Promise<string> => {
  const exit = await Effect.runPromise(
    Effect.exit(state.transaction(operation, body as never)),
  );
  if (exit._tag !== "Failure") {
    throw new Error(`expected "${operation}" to be rejected, it succeeded`);
  }
  return String(
    (exit.cause as { readonly error?: { readonly message?: string } }).error
      ?.message ?? exit.cause,
  );
};

const succeeds = (
  operation: string,
  body: (writer: {
    readonly run: (sql: string, bindings?: ReadonlyArray<never>) => unknown;
  }) => unknown,
): Promise<unknown> =>
  Effect.runPromise(state.transaction(operation, body as never));

/** Every `work_*` table the durable schema creates. */
const schemaWorkTables = (): ReadonlySet<string> => {
  const tables = new Set<string>();
  for (const match of STATE_SCHEMA_SQL.matchAll(
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(work_[a-z_]+)/gi,
  )) {
    tables.add(match[1].toLowerCase());
  }
  return tables;
};

const tablesWithRole = (
  role: WorkPlaneTableRole,
): ReadonlyArray<string> =>
  [...WORK_PLANE_TABLE_ROLES.entries()]
    .filter(([, value]) => value === role)
    .map(([table]) => table);

describe("work mutation seam — classification", () => {
  it("classifies every work table the durable schema declares", () => {
    const declared = schemaWorkTables();
    const classifiedTables = new Set(WORK_PLANE_TABLE_ROLES.keys());
    const unclassified = [...declared].filter(
      (table) => !classifiedTables.has(table),
    );
    const stale = [...classifiedTables].filter(
      (table) => !declared.has(table),
    );
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
    expect(declared.size).toBeGreaterThan(25);
  });

  it("reads the target table through the shapes the repository actually emits", () => {
    const cases: ReadonlyArray<readonly [string, string | null]> = [
      ["INSERT INTO work_tasks(canvas_name) VALUES (?)", "work_tasks"],
      // multi-line + leading whitespace, the repository's literal shape
      ["\n      INSERT INTO work_messages(\n        canvas_name\n      ) VALUES (?)\n", "work_messages"],
      // upsert: the DO UPDATE tail is part of the INSERT, not a second write
      [
        "INSERT INTO work_board_posts(a) VALUES (?) ON CONFLICT(a) DO UPDATE SET b = 1",
        "work_board_posts",
      ],
      ["UPDATE work_board_topics SET post_count = 1 WHERE a = ?", "work_board_topics"],
      ["UPDATE OR REPLACE work_artifacts SET a = 1", "work_artifacts"],
      ["DELETE FROM work_task_messages WHERE a = ?", "work_task_messages"],
      ["REPLACE INTO work_pad_pins(a) VALUES (?)", "work_pad_pins"],
      // formatting must not be a bypass
      ["insert into work_tasks(a) values (?)", "work_tasks"],
      ['INSERT INTO "work_tasks"(a) VALUES (?)', "work_tasks"],
      ["INSERT INTO main.work_tasks(a) VALUES (?)", "work_tasks"],
      ["-- comment\nDELETE FROM work_requests WHERE a = ?", "work_requests"],
      // reads and non-work writes are not the seam's business
      ["SELECT * FROM work_tasks", null],
      ["INSERT INTO station_known_installations(a) VALUES (?)", null],
      ["INSERT INTO other_table SELECT * FROM work_tasks", null],
    ];
    for (const [sql, table] of cases) {
      expect([sql, classifyWorkStatement(sql)?.table ?? null]).toEqual([
        sql,
        table,
      ]);
    }
  });

  it("declares a retirement condition for every journal-free reason", () => {
    for (const [reason, entry] of Object.entries(UNJOURNALED_WORK_REASONS)) {
      expect([reason, entry.why.length > 40, entry.retire.length > 20]).toEqual([
        reason,
        true,
        true,
      ]);
    }
  });
});

describe("work mutation seam — the seam is the only route", () => {
  it("rejects a direct write to every work projection table", async () => {
    const projection = tablesWithRole("projection");
    expect(projection.length).toBeGreaterThan(15);
    for (const table of projection) {
      const message = await failure(`test.direct-write.${table}`, (writer) => {
        // A no-op DELETE: the seam refuses it BEFORE SQLite ever runs it, so
        // the rejection is the seam's, not a constraint's.
        writer.run(`DELETE FROM ${table} WHERE 1 = 0`);
      });
      expect([table, message.includes("work mutation seam")]).toEqual([
        table,
        true,
      ]);
      expect([table, message.includes("not explained by any journal record")])
        .toEqual([table, true]);
    }
  });

  it("names the operation and the table it refused", async () => {
    const message = await failure("test.direct-write.named", (writer) => {
      writer.run("DELETE FROM work_tasks WHERE 1 = 0");
    });
    expect(message).toContain("work_tasks");
    expect(message).toContain("test.direct-write.named");
  });

  it("refuses the trigger-maintained revision table outright", async () => {
    const message = await failure("test.derived", (writer) => {
      writer.run("DELETE FROM work_canvas_revisions WHERE 1 = 0");
    });
    expect(message).toContain("maintained by SQL triggers only");
  });

  it("admits a projection write once a journal record explains it", async () => {
    await succeeds("test.journalled", (writer) => {
      writer.run(
        `INSERT INTO station_known_installations(installation_id, registered_at)
         VALUES (?, ?)`,
        [HOME, NOW] as never,
      );
      writer.run(
        `INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
         VALUES (?, ?, ?)`,
        [HOME, HOME, "1"] as never,
      );
      // Before the record: the projection is closed.
      expect(workMutationScopeForTest()?.journaled).toBe(false);
      writer.run(
        `INSERT INTO work_events(
           event_home, entity_home, seq, protocol, record_type,
           item_kind, item_id, item_canvas_name, item_node_id,
           operation, content_sha256, origin_at, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          HOME,
          HOME,
          "1",
          "junto/work/v1",
          "fact",
          "message",
          "seam-msg-1",
          "main",
          "node-1",
          "message.append",
          SHA,
          NOW,
          NOW,
        ] as never,
      );
      // After the record: the projection is open, in this transaction only.
      expect(workMutationScopeForTest()?.journaled).toBe(true);
      writer.run("DELETE FROM work_tasks WHERE 1 = 0");
    });

    // The next transaction starts closed again — the flag is per transaction.
    const message = await failure("test.journalled.next", (writer) => {
      writer.run("DELETE FROM work_tasks WHERE 1 = 0");
    });
    expect(message).toContain("not explained by any journal record");
  });

  it("admits reads and non-work writes untouched", async () => {
    await succeeds("test.reads", (writer) => {
      writer.run(
        `INSERT INTO station_known_installations(installation_id, registered_at)
         VALUES (?, ?)`,
        ["seam-unrelated", NOW] as never,
      );
    });
  });

  it("admits per-principal read cursors, which are not work facts", async () => {
    await succeeds("test.cursor", (writer) => {
      writer.run("DELETE FROM work_pad_read_cursors WHERE 1 = 0");
      writer.run("DELETE FROM work_board_read_cursors WHERE 1 = 0");
    });
  });
});

describe("work mutation seam — one scope per transaction", () => {
  it("never lets one transaction's journal explain another's projection write", async () => {
    await succeeds("test.outer", (writer) => {
      writer.run(
        `INSERT INTO work_events(
           event_home, entity_home, seq, protocol, record_type,
           item_kind, item_id, item_canvas_name, item_node_id,
           operation, content_sha256, origin_at, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          HOME,
          HOME,
          "2",
          "junto/work/v1",
          "fact",
          "message",
          "seam-msg-2",
          "main",
          "node-1",
          "message.append",
          SHA,
          NOW,
          NOW,
        ] as never,
      );
      expect(workMutationScopeForTest()?.journaled).toBe(true);

      // A second engine's transaction opening inside this one gets its own
      // scope: this database's record must not vouch for that one's write.
      const closeInner = beginWorkMutationScope("test.inner");
      try {
        expect(workMutationScopeForTest()?.operation).toBe("test.inner");
        expect(workMutationScopeForTest()?.journaled).toBe(false);
        expect(() => writer.run("DELETE FROM work_tasks WHERE 1 = 0")).toThrow(
          /not explained by any journal record/,
        );
      } finally {
        closeInner();
      }

      // Closing the inner scope restores the outer one, still journalled.
      expect(workMutationScopeForTest()?.operation).toBe("test.outer");
      writer.run("DELETE FROM work_tasks WHERE 1 = 0");
    });
  });
});

describe("work mutation seam — the declared journal-free escape", () => {
  it("admits only inside its own window and closes behind itself", async () => {
    await succeeds("test.escape", (writer) => {
      unjournaledWorkMutation("test.fixture-seed", () => {
        writer.run("DELETE FROM work_tasks WHERE 1 = 0");
      });
      expect(workMutationScopeForTest()?.unjournaled).toBeUndefined();
      expect(() => writer.run("DELETE FROM work_tasks WHERE 1 = 0")).toThrow(
        /not explained by any journal record/,
      );
    });
  });

  it("closes its window even when the body throws", async () => {
    await succeeds("test.escape.throws", (writer) => {
      expect(() =>
        unjournaledWorkMutation("test.fixture-seed", () => {
          throw new Error("body failed");
        }),
      ).toThrow("body failed");
      expect(workMutationScopeForTest()?.unjournaled).toBeUndefined();
      expect(() => writer.run("DELETE FROM work_tasks WHERE 1 = 0")).toThrow(
        /not explained by any journal record/,
      );
    });
  });

  it("refuses to run outside a state transaction", () => {
    expect(() =>
      unjournaledWorkMutation("test.fixture-seed", () => undefined),
    ).toThrow(/outside any state transaction/);
  });

  it("refuses to nest", async () => {
    await succeeds("test.escape.nested", () => {
      expect(() =>
        unjournaledWorkMutation("test.fixture-seed", () => {
          unjournaledWorkMutation("test.fixture-seed", () => undefined);
        }),
      ).toThrow(/one declaration per transaction/);
    });
  });
});

describe("work mutation seam — scope lifecycle", () => {
  it("has no scope open outside a transaction", () => {
    expect(workMutationScopeForTest()).toBeUndefined();
  });

  it("closes the scope when a transaction body throws", async () => {
    await Effect.runPromise(
      Effect.exit(
        state.transaction("test.scope.throws", () => {
          throw new Error("body failed");
        }),
      ),
    );
    expect(workMutationScopeForTest()).toBeUndefined();
    // A leaked scope would make the very next transaction fail loudly.
    await succeeds("test.scope.after", () => undefined);
  });
});

/**
 * The sink attribution the in-memory world rests on.
 *
 * The world may serve a canvas's resident sinks only while
 * `work_canvas_revisions` is unchanged, and when the counter DOES move it
 * re-reads the sinks this seam announced. Two things therefore have to hold,
 * and neither can be argued from the code — both are checked against the
 * live schema and the live source:
 *
 * 1. the table list the seam scans is EXACTLY the set of tables whose triggers
 *    move that counter, and
 * 2. every mutation statement this repository can emit against one of those
 *    tables is attributable to a sink. An unattributable one is not a
 *    correctness bug — it degrades to a full rebuild — but it silently gives
 *    back the whole point of the world, so it fails here instead.
 */
describe("work mutation sink attribution", () => {
  it("scans exactly the tables whose triggers move the canvas revision", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_SQL);
      const triggers = database
        .prepare(
          `SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'trigger'`,
        )
        .all() as unknown as ReadonlyArray<{
        readonly tbl_name: string;
        readonly sql: string;
      }>;
      const bumping = new Set(
        triggers
          .filter((trigger) => trigger.sql.includes("work_canvas_revisions"))
          .map((trigger) => trigger.tbl_name),
      );
      expect([...CANVAS_REVISION_TABLES].sort()).toEqual([...bumping].sort());
    } finally {
      database.close();
    }
  });

  it("reads the sink out of every mutation the work plane can emit", () => {
    const sources = [
      "src/main/junto/work/repository.ts",
      "src/main/junto/work/journal.ts",
      "src/main/junto/content/inline-media-migration.ts",
    ];
    // The three statements whose target table is computed, and what each can
    // resolve to. Kept in step with scripts/single-write-seam-register.json,
    // which is the gate that refuses a computed target it does not declare.
    const dynamic: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      ["${table}", ["work_tasks", "work_requests"]],
      [
        "${pendingTable}",
        ["work_pending_commands"],
      ],
      [
        "${table}",
        [
          "work_pad_images",
          "work_pad_shapes",
          "work_pad_edges",
          "work_pad_inks",
          "work_pad_pins",
        ],
      ],
    ];

    const statements: Array<string> = [];
    for (const source of sources) {
      const text = readFileSync(source, "utf8");
      for (const match of text.matchAll(/`([^`]*)`/g)) {
        const sql = match[1];
        if (!/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql.trim())) {
          continue;
        }
        if (sql.includes("${")) {
          for (const [expression, tables] of dynamic) {
            if (!sql.includes(expression)) continue;
            for (const table of tables) {
              statements.push(sql.split(expression).join(table));
            }
          }
          continue;
        }
        statements.push(sql);
      }
    }
    expect(statements.length).toBeGreaterThan(20);

    const unattributed: Array<string> = [];
    let attributed = 0;
    for (const sql of statements) {
      const statement = classifyWorkStatement(sql);
      if (statement === null) continue;
      if (!CANVAS_REVISION_TABLES.has(statement.table)) continue;
      if (workStatementSinkParams(statement, sql) === null) {
        unattributed.push(sql.replace(/\s+/g, " ").trim().slice(0, 100));
        continue;
      }
      attributed += 1;
    }
    expect(unattributed).toEqual([]);
    // Every table carrying a revision trigger that this source writes at all
    // is covered; the count is a floor so the scan cannot silently find none.
    expect(attributed).toBeGreaterThanOrEqual(15);
  });
});
