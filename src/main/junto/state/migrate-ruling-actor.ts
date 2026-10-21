import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * State migration that puts the actor on every resource ruling: `actor_kind`
 * (seat, operator or automation) and `actor_node_id` (the seat's node id, none
 * for the operator and an automation), so `junto op show` and `junto op list`
 * read a seat's own writes.
 *
 * The table is rebuilt empty. No ruling was ever written before this step: the
 * task and artifact repositories that write them were not wired into main, so
 * no database holds one. A ruling found here has no actor to give it, so the
 * step refuses rather than invent one, and the whole migration rolls back.
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

export const migrateRulingActor = (database: StateSchemaMigrationDatabase): void => {
  const held = Number(database.prepare("SELECT count(*) AS n FROM resource_rulings").get()!.n);
  if (held !== 0) {
    throw new Error(`resource_rulings holds ${held} rulings with no actor; this step adds the actor and cannot invent one`);
  }
  database.exec("DROP TABLE resource_rulings");
  database.exec(RESOURCE_RULINGS_ACTOR_SQL);
};
