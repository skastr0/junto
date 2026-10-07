import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";

// Every mailbox mutation moves its canvas Work counter, independently of a
// document, a facade cache, or the repository method used to write the row.
const PROJECTED_TABLES = [
  ["work_messages", "canvas_name"],
  ["work_delivery_receipts", "delivered_canvas_name"],
] as const;

describe("Work revision triggers", () => {
  it("carries insert, update and delete triggers on every projected table", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(STATE_SCHEMA_SQL);
      const triggers = database
        .prepare(
          `SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger'`,
        )
        .all() as unknown as ReadonlyArray<{
        readonly name: string;
        readonly tbl_name: string;
        readonly sql: string;
      }>;
      const bumping = triggers.filter((trigger) =>
        trigger.sql.includes("work_canvas_revisions"),
      );

      const missing: string[] = [];
      const misrouted: string[] = [];
      for (const [table, column] of PROJECTED_TABLES) {
        for (const [event, alias] of [
          ["INSERT", "NEW"],
          ["UPDATE", "OLD"], // an UPDATE trigger may key on either row
          ["DELETE", "OLD"],
        ] as const) {
          const covering = bumping.filter(
            (trigger) =>
              trigger.tbl_name === table &&
              new RegExp(`AFTER\\s+${event}\\s+ON\\s+${table}\\b`).test(
                trigger.sql,
              ),
          );
          if (covering.length === 0) {
            missing.push(`${table} ${event}`);
            continue;
          }
          const keyed = covering.some(
            (trigger) =>
              trigger.sql.includes(`NEW.${column}`) ||
              trigger.sql.includes(`OLD.${column}`),
          );
          if (!keyed) misrouted.push(`${table} ${event} (${alias}.${column})`);
        }
      }
      expect(missing).toEqual([]);
      expect(misrouted).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("moves the revision for a direct write to every projected table", () => {
    // The behavioural half: no repository call path involved, just the row.
    // Whatever future code writes these tables, the witness fires.
    //
    // Foreign keys are off for this probe on purpose: it asks whether the
    // trigger fires, not whether the row is referentially complete, and
    // building every FK chain would test the schema's other half instead.
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec(STATE_SCHEMA_SQL);
      // work_messages_require_cc_home refuses a mailbox row that is not homed
      // on the configured Command Center, so the probe configures one and
      // homes every synthetic row there.
      database.exec(`
        INSERT INTO station_known_installations(installation_id, registered_at)
        VALUES ('home', '${"2026-08-18T00:00:00.000Z"}');
        INSERT INTO station_installation(singleton, installation_id, created_at)
        VALUES (1, 'home', '${"2026-08-18T00:00:00.000Z"}');
        INSERT INTO station_configuration(
          singleton, role, host_id, agent_host_id,
          command_center_installation_id, supervised_preferred, configured_at
        ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, '${"2026-08-18T00:00:00.000Z"}');
      `);
      const revision = (): number =>
        (
          database
            .prepare(
              `SELECT revision FROM work_canvas_revisions WHERE canvas_name = 'probe'`,
            )
            .get() as { revision: number } | undefined
        )?.revision ?? 0;

      const seat = `seat_${"a".repeat(64)}`;
      // Column values that satisfy a CHECK the generic filler cannot guess.
      const overrides: Record<string, Record<string, string>> = {
        work_messages: { role: "'user'", actor_seat_id: `'${seat}'` },
        work_delivery_receipts: {
          delivered_item_kind: "'message'",
          actor_seat_id: `'${seat}'`,
        },
      };

      const rowFor = (table: string, column: string) => {
        const columns = database
          .prepare(`PRAGMA table_info(${table})`)
          .all() as unknown as ReadonlyArray<{
          readonly name: string;
          readonly type: string;
          readonly notnull: number;
          readonly dflt_value: string | null;
        }>;
        const required = columns.filter(
          (c) => c.notnull === 1 && c.dflt_value === null,
        );
        const values = required.map((c) => {
          const override = overrides[table]?.[c.name];
          if (override !== undefined) return override;
          if (c.name === column) return "'probe'";
          if (c.type === "INTEGER" || c.type === "REAL") return "0";
          if (c.name.endsWith("_json")) return "'[]'";
          // entity_home, fact_event_home and fact_entity_home carry a
          // cross-column CHECK that they are all the same installation.
          if (c.name.endsWith("_home")) return "'home'";
          return `'${c.name}'`;
        });
        return { columns: required.map((c) => c.name), values };
      };

      // Three phases: inserting in declaration order, then updating, then
      // deleting in reverse keeps every parent alive for as long as its
      // children need it.
      for (const [table, column] of PROJECTED_TABLES) {
        const before = revision();
        const row = rowFor(table, column);
        database.exec(
          `INSERT INTO ${table}(${row.columns.join(", ")}) VALUES (${row.values.join(", ")})`,
        );
        expect(revision(), `${table} insert`).toBeGreaterThan(before);
      }
      for (const [table, column] of PROJECTED_TABLES) {
        const before = revision();
        database.exec(
          `UPDATE ${table} SET ${column} = ${column} WHERE ${column} = 'probe'`,
        );
        expect(revision(), `${table} update`).toBeGreaterThan(before);
      }
      for (const [table, column] of [...PROJECTED_TABLES].reverse()) {
        const before = revision();
        database.exec(`DELETE FROM ${table} WHERE ${column} = 'probe'`);
        expect(revision(), `${table} delete`).toBeGreaterThan(before);
      }
    } finally {
      database.close();
    }
  });
});

