import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * State migration that puts the actor on every resource ruling: `actor_kind`
 * (seat, operator or automation) and `actor_node_id` (the seat's node id, none
 * for the operator and an automation), so `junto op show` and `junto op list`
 * read a seat's own writes.
 *
 * The table is rebuilt and every ruling kept. A ruling from before this step
 * predates actor recording, and only dev builds wrote any (main's task verbs
 * were wired onto the ruler minutes before it), so it is carried over as the
 * operator's with no node id. A seat's `junto op list` does not show it.
 *
 * The DDL below is this step's own copy. It never follows the head schema.
 */
const RESOURCE_RULINGS_ACTOR_SQL = `
  CREATE TABLE IF NOT EXISTS resource_rulings (
    canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
    writer TEXT NOT NULL CHECK (length(writer) BETWEEN 1 AND 256),
    op_id TEXT NOT NULL CHECK (length(op_id) = 26),
    kind TEXT NOT NULL CHECK (kind IN ('applied', 'refused')),
    ruling_json TEXT NOT NULL CHECK (json_valid(ruling_json)),
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('seat', 'operator', 'automation')),
    actor_node_id TEXT CHECK (
      (actor_kind = 'seat') = (actor_node_id IS NOT NULL)
      AND (actor_node_id IS NULL OR length(actor_node_id) BETWEEN 1 AND 256)
    ),
    PRIMARY KEY (canvas_name, writer, op_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS resource_rulings_actor
    ON resource_rulings(canvas_name, writer, actor_node_id, op_id);
`;

const KEPT = ["canvas_name", "writer", "op_id", "kind", "ruling_json"] as const;

export const migrateRulingActor = (database: StateSchemaMigrationDatabase): void => {
  const stored = database
    .prepare(`SELECT ${KEPT.join(", ")} FROM resource_rulings ORDER BY canvas_name, writer, op_id`)
    .all() as unknown as ReadonlyArray<Record<(typeof KEPT)[number], string>>;
  database.exec("DROP TABLE resource_rulings");
  database.exec(RESOURCE_RULINGS_ACTOR_SQL);
  const insert = database.prepare(
    `INSERT INTO resource_rulings (${KEPT.join(", ")}, actor_kind, actor_node_id)
     VALUES (${KEPT.map(() => "?").join(", ")}, 'operator', NULL)`,
  );
  for (const row of stored) insert.run(...KEPT.map((column) => row[column]));
  const kept = Number(database.prepare("SELECT count(*) AS n FROM resource_rulings").get()!.n);
  if (kept !== stored.length) throw new Error("a ruling did not survive the step");
};
