/**
 * The mutation seam's two safety claims, tested as claims rather than as code.
 *
 * `work/mutation-seam.ts` states them in its own words, and the in-memory
 * world rests on both:
 *
 *   1. "a `projection` write is admitted only after a `journal` record row has
 *      been written in the SAME transaction" — the admission law, which
 *      `state/engine.ts` runs on every statement.
 *   2. "UNATTRIBUTABLE MEANS COARSE, NEVER SILENT ... The failure direction is
 *      slow, never stale" — a statement the seam cannot read must announce
 *      `undefined`, which costs a full rebuild, instead of announcing a sink
 *      it guessed wrong.
 *
 * Both are parsed out of SQL text by regex, so both hold only for the
 * statement SHAPES the parser understands. This file is the shape contract:
 * every shape below is legal SQLite that a future write path can reach for,
 * and for each one the seam must either read it exactly or refuse to read it
 * at all. Announcing the wrong sink is the one outcome that is not allowed —
 * it re-reads some other sink and leaves the changed one resident and stale.
 *
 * These are not tests for a past mistake. They are the boundary of what the
 * parser is allowed to claim, checked against shapes it does not yet see.
 */
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  classifyWorkStatement,
  workStatementSinkParams,
} from "../src/main/vellum/work/mutation-seam";

/**
 * What the seam would tell the world about one statement: the sink it names,
 * `"coarse"` when it refuses to guess, or `"invisible"` when it does not see
 * the statement as a work mutation at all.
 */
const announcementFor = (
  sql: string,
  bindings: ReadonlyArray<unknown>,
): string => {
  const statement = classifyWorkStatement(sql);
  if (statement === null) return "invisible";
  const params = workStatementSinkParams(statement, sql);
  if (params === null) return "coarse";
  const canvas = bindings[params.canvas];
  const node = bindings[params.node];
  if (typeof canvas !== "string" || typeof node !== "string") return "coarse";
  return `${canvas}/${node}`;
};

/** Legal SQLite, so a shape the parser must not be wrong about. */
const executes = (sql: string, bindings: ReadonlyArray<unknown>): boolean => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      `CREATE TABLE work_messages(
         canvas_name TEXT NOT NULL,
         node_id TEXT NOT NULL,
         message_id TEXT NOT NULL,
         PRIMARY KEY (canvas_name, node_id, message_id)
       )`,
    );
    database.prepare(sql).run(...(bindings as ReadonlyArray<never>));
    return true;
  } catch {
    return false;
  } finally {
    database.close();
  }
};

describe("what the seam is allowed to claim about a statement", () => {
  it("never announces a sink the statement did not touch", () => {
    const shapes: ReadonlyArray<{
      readonly label: string;
      readonly sql: string;
      readonly bindings: ReadonlyArray<unknown>;
      /** The sinks this statement actually writes. */
      readonly touches: ReadonlyArray<string>;
    }> = [
      {
        label: "a second VALUES tuple lands on a different sink",
        sql:
          `INSERT INTO work_messages(canvas_name, node_id, message_id) ` +
          `VALUES (?, ?, ?), (?, ?, ?)`,
        bindings: ["factory", "left", "m1", "factory", "right", "m2"],
        touches: ["factory/left", "factory/right"],
      },
      {
        label: "a subquery names the sink columns before the WHERE does",
        sql:
          `DELETE FROM work_messages
             WHERE message_id IN (
               SELECT message_id FROM work_messages
               WHERE canvas_name = ? AND node_id = ?
             )
             AND canvas_name = ? AND node_id = ?`,
        bindings: ["factory", "source", "factory", "target"],
        touches: ["factory/target"],
      },
      {
        label: "the only sink predicate belongs to a subquery",
        sql:
          `DELETE FROM work_messages
             WHERE message_id IN (
               SELECT message_id FROM work_messages
               WHERE canvas_name = ? AND node_id = ?
             )`,
        bindings: ["factory", "source"],
        // Every row of every sink whose message_id the subquery names.
        touches: ["factory/source", "factory/anything-sharing-a-message-id"],
      },
      {
        label: "explicit ?NNN parameter indices",
        sql:
          `UPDATE work_messages SET message_id = ?3 ` +
          `WHERE canvas_name = ?1 AND node_id = ?2`,
        bindings: ["factory", "target", "m9"],
        touches: ["factory/target"],
      },
      {
        label: "the SET clause moves the row to another sink",
        sql:
          `UPDATE work_messages SET canvas_name = ?, node_id = ? ` +
          `WHERE canvas_name = ? AND node_id = ? AND message_id = ?`,
        bindings: ["factory", "moved", "factory", "origin", "m1"],
        touches: ["factory/origin", "factory/moved"],
      },
    ];

    const wrong: Array<string> = [];
    for (const shape of shapes) {
      // A shape SQLite rejects is not a shape the seam has to survive.
      expect(
        executes(shape.sql, shape.bindings),
        `${shape.label}: must be legal SQLite for this test to mean anything`,
      ).toBe(true);
      const announced = announcementFor(shape.sql, shape.bindings);
      // Reading it exactly is ideal; refusing to read it is acceptable —
      // "coarse" costs a rebuild. Naming a sink it did not touch, or naming
      // only one of several, leaves the rest resident and stale.
      const exact =
        shape.touches.length === 1 && announced === shape.touches[0];
      if (announced !== "coarse" && !exact) {
        wrong.push(
          `${shape.label}: touches ${JSON.stringify(shape.touches)} but ` +
            `announced "${announced}"`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it("sees a work mutation written with a leading WITH clause", () => {
    // SQLite accepts a common table expression in front of INSERT, UPDATE and
    // DELETE. A statement the seam does not classify is not merely
    // unannounced — it also skips the admission law, so a projection row can
    // be written with no journal record behind it and nothing says so.
    const shapes = [
      `WITH source(id) AS (VALUES ('m1'))
         INSERT INTO work_messages(canvas_name, node_id, message_id)
         SELECT ?, ?, id FROM source`,
      `WITH doomed AS (SELECT message_id FROM work_messages)
         DELETE FROM work_messages
         WHERE canvas_name = ? AND node_id = ?
           AND message_id IN (SELECT message_id FROM doomed)`,
    ];
    const bindings = ["factory", "target"];
    const invisible: Array<string> = [];
    for (const sql of shapes) {
      expect(
        executes(sql, bindings),
        "must be legal SQLite for this test to mean anything",
      ).toBe(true);
      if (classifyWorkStatement(sql) === null) {
        invisible.push(sql.replace(/\s+/g, " ").trim().slice(0, 90));
      }
    }
    expect(invisible).toEqual([]);
  });
});
