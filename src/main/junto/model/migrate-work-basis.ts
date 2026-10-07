import type { StateSchemaMigrationDatabase } from "../state/migrations";
import {
  WORK_FACT_CANVAS_BASIS_TRIGGER_SQL,
  WORK_FACTS_CANVAS_TABLE_SQL,
} from "./work-basis-schema";

/** Keep historical event hashes as provenance; no invented post-cutover basis. */
export const migrateWorkFactBasis = (
  database: StateSchemaMigrationDatabase,
): void => {
  const sideObjects = database
    .prepare(
      `SELECT name,sql FROM sqlite_schema
    WHERE tbl_name='work_facts' AND type IN ('index','trigger') AND sql IS NOT NULL
    ORDER BY type,name`,
    )
    .all();
  const count = Number(
    database.prepare("SELECT count(*) AS n FROM work_facts").get()!.n,
  );
  database.exec(`CREATE TABLE work_facts__migrate_bak AS
    SELECT fact.*, event.item_canvas_name AS copied_canvas_name
    FROM work_facts fact JOIN work_events event USING(event_home,entity_home,seq)`);
  if (
    Number(
      database
        .prepare("SELECT count(*) AS n FROM work_facts__migrate_bak")
        .get()!.n,
    ) !== count
  ) {
    throw new Error("installed fact does not have its Work event");
  }
  database.exec("DROP TABLE work_facts");
  database.exec(WORK_FACTS_CANVAS_TABLE_SQL);
  const columns = database
    .prepare("PRAGMA table_info(work_facts)")
    .all()
    .map((row) => String(row.name));
  const expression = (column: string): string => {
    if (column === "basis_kind") return "'historical'";
    if (column.startsWith("basis_")) return "NULL";
    return column;
  };
  const copied = `SELECT ${columns.map(expression).join(",")} FROM work_facts__migrate_bak`;
  const current = `SELECT ${columns.join(",")} FROM work_facts`;
  database.exec(`INSERT INTO work_facts(${columns.join(",")}) ${copied}`);
  if (
    database
      .prepare(`SELECT * FROM (${copied} EXCEPT ${current}) LIMIT 1`)
      .get() ||
    database
      .prepare(`SELECT * FROM (${current} EXCEPT ${copied}) LIMIT 1`)
      .get() ||
    Number(
      database.prepare("SELECT count(*) AS n FROM work_facts").get()!.n,
    ) !== count
  ) {
    throw new Error("fact basis migration failed replacement parity");
  }
  database.exec("DROP TABLE work_facts__migrate_bak");
  for (const object of sideObjects) {
    database.exec(
      object.name === "work_fact_authorial_basis_resolves"
        ? WORK_FACT_CANVAS_BASIS_TRIGGER_SQL
        : String(object.sql),
    );
  }
};
