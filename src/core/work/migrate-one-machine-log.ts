import type { StateSchemaMigrationDatabase } from "../state/migrations";

/**
 * State migration 14 -> 15. The tables that carried tasks between machines go,
 * and the work log is rebuilt without its links to them: every fact row
 * survives with its identity, hash and body, and a fact minted under a basis
 * that no longer exists keeps its hash as provenance (`historical`).
 *
 * The DDL below is this step's own copy. It never follows the head schema.
 */
export const ONE_MACHINE_LOG_REMOVED_TABLES = [
  "work_commands",
  "work_dispositions",
  "work_pending_commands",
  "station_received_cursors",
  "station_peer_ack_cursors",
  "station_projection_head",
  "station_projection_versions",
  "station_pairing",
  "box_resources",
] as const;

export const ONE_MACHINE_LOG_RETIRED_FACT_COLUMNS = [
  "basis_projected_generation",
  "basis_projected_content_sha256",
  "basis_command_event_home",
  "basis_command_entity_home",
  "basis_command_seq",
  "basis_command_sha256",
] as const;

const WORK_EVENTS_TABLE_SQL = `
  CREATE TABLE work_events (
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    seq TEXT NOT NULL
      CHECK (
        length(seq) BETWEEN 1 AND 32
        AND seq NOT GLOB '*[^0-9]*'
        AND substr(seq, 1, 1) <> '0'
      ),
    protocol TEXT NOT NULL CHECK (protocol = 'junto/work/v1'),
    record_type TEXT NOT NULL CHECK (record_type = 'fact'),
    item_kind TEXT NOT NULL CHECK (length(item_kind) BETWEEN 1 AND 32),
    item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 256),
    item_canvas_name TEXT NOT NULL
      CHECK (length(item_canvas_name) BETWEEN 1 AND 256),
    item_node_id TEXT NOT NULL
      CHECK (length(item_node_id) BETWEEN 1 AND 256),
    operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
    content_sha256 TEXT NOT NULL
      CHECK (
        length(content_sha256) = 64
        AND content_sha256 NOT GLOB '*[^a-f0-9]*'
      ),
    origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
    received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
    PRIMARY KEY (event_home, entity_home, seq),
    UNIQUE (event_home, entity_home, seq, record_type),
    CHECK (event_home = entity_home),
    FOREIGN KEY (event_home, entity_home)
      REFERENCES work_event_sequences(event_home, entity_home)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (event_home)
      REFERENCES station_known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (entity_home)
      REFERENCES station_known_installations(installation_id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID
`;

const WORK_FACTS_TABLE_SQL = `
  CREATE TABLE work_facts (
    event_home TEXT NOT NULL,
    entity_home TEXT NOT NULL,
    seq TEXT NOT NULL,
    record_type TEXT NOT NULL DEFAULT 'fact'
      CHECK (record_type = 'fact'),
    predecessor_event_home TEXT,
    predecessor_entity_home TEXT,
    predecessor_seq TEXT
      CHECK (
        predecessor_seq IS NULL
        OR (
          length(predecessor_seq) BETWEEN 1 AND 32
          AND predecessor_seq NOT GLOB '*[^0-9]*'
          AND substr(predecessor_seq, 1, 1) <> '0'
        )
      ),
    result_json TEXT NOT NULL
      CHECK (
        length(result_json) BETWEEN 2 AND 262144
        AND json_valid(result_json)
      ),
    basis_kind TEXT NOT NULL CHECK (basis_kind IN ('canvas', 'historical')),
    basis_canvas_name TEXT,
    basis_canvas_seq INTEGER CHECK (
      basis_canvas_seq IS NULL OR basis_canvas_seq BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (event_home, entity_home, seq),
    CHECK (event_home = entity_home),
    CHECK (
      (
        basis_kind = 'historical'
        AND basis_canvas_name IS NULL
        AND basis_canvas_seq IS NULL
      )
      OR
      (
        basis_kind = 'canvas'
        AND basis_canvas_name IS NOT NULL
        AND basis_canvas_seq IS NOT NULL
      )
    ),
    CHECK (
      (
        predecessor_event_home IS NULL
        AND predecessor_entity_home IS NULL
        AND predecessor_seq IS NULL
      )
      OR
      (
        predecessor_event_home IS NOT NULL
        AND predecessor_entity_home IS NOT NULL
        AND predecessor_seq IS NOT NULL
        AND predecessor_entity_home = entity_home
      )
    ),
    FOREIGN KEY (event_home, entity_home, seq, record_type)
      REFERENCES work_events(event_home, entity_home, seq, record_type)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT,
    FOREIGN KEY (
      predecessor_event_home,
      predecessor_entity_home,
      predecessor_seq
    ) REFERENCES work_facts(event_home, entity_home, seq)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
  ) STRICT, WITHOUT ROWID
`;

const EVENT_COLUMNS =
  "event_home, entity_home, seq, protocol, record_type, item_kind, item_id, item_canvas_name, item_node_id, operation, content_sha256, origin_at, received_at";

const FACT_COLUMNS =
  "event_home, entity_home, seq, record_type, predecessor_event_home, predecessor_entity_home, predecessor_seq, result_json, basis_kind, basis_canvas_name, basis_canvas_seq";

/** A fact keeps a canvas basis; any other basis becomes provenance only. */
const FACT_COPY_SQL = `
  SELECT event_home, entity_home, seq, record_type, predecessor_event_home,
    predecessor_entity_home, predecessor_seq, result_json,
    CASE WHEN basis_kind = 'canvas' THEN 'canvas' ELSE 'historical' END,
    CASE WHEN basis_kind = 'canvas' THEN basis_canvas_name END,
    CASE WHEN basis_kind = 'canvas' THEN basis_canvas_seq END
  FROM work_facts__migrate_bak
`;

/** Rejected a received fact minted at another canvas seq; the check stays at mint. */
const RETIRED_FACT_TRIGGER = "work_fact_authorial_basis_resolves";

const count = (database: StateSchemaMigrationDatabase, sql: string): number =>
  Number(database.prepare(sql).get()!.n);

const differs = (
  database: StateSchemaMigrationDatabase,
  left: string,
  right: string,
): boolean =>
  database.prepare(`SELECT 1 FROM (${left} EXCEPT ${right}) LIMIT 1`).get() !== undefined ||
  database.prepare(`SELECT 1 FROM (${right} EXCEPT ${left}) LIMIT 1`).get() !== undefined;

export const migrateOneMachineLog = (
  database: StateSchemaMigrationDatabase,
): void => {
  const sideObjects = database
    .prepare(
      `SELECT name, sql FROM sqlite_schema
        WHERE tbl_name IN ('work_events', 'work_facts')
          AND type IN ('index', 'trigger')
          AND sql IS NOT NULL
          AND name <> '${RETIRED_FACT_TRIGGER}'
        ORDER BY type, name`,
    )
    .all();
  const facts = count(database, "SELECT count(*) AS n FROM work_facts");

  database.exec(`
    CREATE TABLE work_events__migrate_bak AS
      SELECT event.* FROM work_events AS event
      JOIN work_facts AS fact USING (event_home, entity_home, seq);
    CREATE TABLE work_facts__migrate_bak AS SELECT * FROM work_facts;
  `);
  if (
    count(database, "SELECT count(*) AS n FROM work_events__migrate_bak") !== facts ||
    count(database, "SELECT count(*) AS n FROM work_events__migrate_bak WHERE record_type <> 'fact' OR event_home <> entity_home") !== 0
  ) {
    throw new Error("an installed fact does not have its own work event");
  }

  database.exec("DROP TABLE work_facts; DROP TABLE work_events;");
  for (const table of ONE_MACHINE_LOG_REMOVED_TABLES) {
    database.exec(`DROP TABLE ${table}`);
  }

  database.exec(WORK_EVENTS_TABLE_SQL);
  database.exec(WORK_FACTS_TABLE_SQL);
  database.exec(`
    INSERT INTO work_events(${EVENT_COLUMNS})
      SELECT ${EVENT_COLUMNS} FROM work_events__migrate_bak;
    INSERT INTO work_facts(${FACT_COLUMNS}) ${FACT_COPY_SQL};
  `);
  if (
    count(database, "SELECT count(*) AS n FROM work_facts") !== facts ||
    count(database, "SELECT count(*) AS n FROM work_events") !== facts ||
    differs(
      database,
      `SELECT ${EVENT_COLUMNS} FROM work_events`,
      `SELECT ${EVENT_COLUMNS} FROM work_events__migrate_bak`,
    ) ||
    differs(database, `SELECT ${FACT_COLUMNS} FROM work_facts`, FACT_COPY_SQL)
  ) {
    throw new Error("the work log did not survive its rebuild");
  }

  database.exec("DROP TABLE work_facts__migrate_bak; DROP TABLE work_events__migrate_bak;");
  for (const object of sideObjects) database.exec(String(object.sql));
};
