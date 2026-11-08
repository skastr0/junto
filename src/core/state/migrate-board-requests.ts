import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * The board and requests deletions step (0.10). The bulletin board and the
 * requests node leave the database here, in one consolidate step:
 *
 * - every board and requests node goes with its kind's table, and so does
 *   every wire that touches one;
 * - every `participates` and `reviews` wire goes, and the `wires.verb`
 *   CHECK no longer names either; the board ports and `verdict.post` leave
 *   every stored mask;
 * - the board topics, posts and read cursors, and the requests, go; so do the
 *   request lane of the old task store and the board owners of content refs;
 * - the journal rows of the retired board and request operations go, and so
 *   do v32's retained pad patches. Nothing sends them to another machine,
 *   a peer reads past a gap in seq, and the sequence allocator is untouched,
 *   so a seq is never reused.
 *
 * Nothing else moves. The DDL below is this step's own copy. It never follows
 * the head schema.
 */

/** Node tables of the removed kinds. */
export const BOARD_REQUESTS_REMOVED_KIND_TABLES = ["boards", "request_boards"] as const;

/** Work tables with no successor, children before parents. */
export const BOARD_REQUESTS_REMOVED_FEATURE_TABLES = [
  "work_board_read_cursors",
  "work_board_posts",
  "work_board_topics",
  "work_requests",
] as const;

export const BOARD_REQUESTS_REMOVED_TABLES = [
  ...BOARD_REQUESTS_REMOVED_KIND_TABLES,
  ...BOARD_REQUESTS_REMOVED_FEATURE_TABLES,
] as const;

/**
 * Tables rebuilt with the rows they keep. The journal is rebuilt from its own
 * stored text: only a rebuild may leave rows behind, and its text is the same.
 */
export const BOARD_REQUESTS_REPLACED_TABLES = [
  "wires",
  "work_task_messages",
  "work_task_transitions",
  "content_refs",
  "work_events",
  "work_facts",
] as const;

/** Journal operations no code reads, writes or sends any more. */
export const BOARD_REQUESTS_RETIRED_OPERATIONS = [
  "board.topic.create",
  "board.post.append",
  "request.create",
  "request.resolve",
  "pad.patch",
] as const;

const RETIRED_VERBS = ["participates", "reviews"] as const;
/** Ports that leave every stored mask: the board's, and the retired verdict post. */
const RETIRED_PORTS: ReadonlySet<string> = new Set([
  "board.list",
  "board.create_topic",
  "board.post",
  "board.mark_read",
  "verdict.post",
]);
const RETIRED_OWNER_KINDS = ["board_topic", "board_post"] as const;

const list = (values: ReadonlyArray<string>): string => values.map((value) => `'${value}'`).join(", ");

const WIRES_SQL = `
  CREATE TABLE wires (
      canvas_name TEXT NOT NULL REFERENCES canvases(canvas_name) ON UPDATE CASCADE,
      id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      verb TEXT NOT NULL CHECK (verb IN ('messages', 'navigates', 'flows')),
      from_side TEXT CHECK (from_side IN ('top', 'right', 'bottom', 'left')),
      to_side TEXT CHECK (to_side IN ('top', 'right', 'bottom', 'left')),
      mask_json TEXT CHECK (mask_json IS NULL OR json_valid(mask_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (canvas_name, id)
    ) STRICT, WITHOUT ROWID;

  CREATE INDEX wires_from ON wires(canvas_name, from_id, id);

  CREATE INDEX wires_to ON wires(canvas_name, to_id, id);
`;

const WIRES_TRIGGERS_SQL = "";

const TASK_MESSAGES_SQL = `
  CREATE TABLE work_task_messages (
      canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
      node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
      parent_lane TEXT NOT NULL CHECK (parent_lane IN ('task')),
      item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 256),
      message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
      position INTEGER NOT NULL CHECK (position >= 0),
      message_kind TEXT NOT NULL CHECK (message_kind IN ('brief', 'history')),
      entity_home TEXT NOT NULL,
      fact_event_home TEXT NOT NULL,
      fact_entity_home TEXT NOT NULL,
      fact_seq TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
      parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
      context_id TEXT,
      reference_task_ids_json TEXT
        CHECK (
          reference_task_ids_json IS NULL
          OR json_valid(reference_task_ids_json)
        ),
      metadata_json TEXT
        CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
      origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
      received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
      PRIMARY KEY (
        canvas_name,
        node_id,
        parent_lane,
        item_id,
        message_id
      ),
      UNIQUE (canvas_name, node_id, parent_lane, item_id, position),
      CHECK (entity_home = fact_entity_home),
      CHECK (fact_event_home = fact_entity_home),
      FOREIGN KEY (entity_home)
        REFERENCES known_installations(installation_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT,
      FOREIGN KEY (fact_event_home, fact_entity_home, fact_seq)
        REFERENCES work_facts(event_home, entity_home, seq)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
    ) STRICT, WITHOUT ROWID;

  CREATE UNIQUE INDEX work_task_messages_sink_identity
      ON work_task_messages(canvas_name, node_id, message_id);

  CREATE INDEX work_task_messages_thread
      ON work_task_messages(
        canvas_name,
        node_id,
        parent_lane,
        item_id,
        position
      );
`;

const TASK_MESSAGES_TRIGGERS_SQL = `
  CREATE TRIGGER work_canvas_revision_task_messages_delete
      AFTER DELETE ON work_task_messages
      BEGIN
        INSERT INTO work_canvas_revisions(canvas_name, revision)
        VALUES (OLD.canvas_name, 1)
        ON CONFLICT(canvas_name) DO UPDATE
          SET revision = work_canvas_revisions.revision + 1;
      END;

  CREATE TRIGGER work_canvas_revision_task_messages_insert
      AFTER INSERT ON work_task_messages
      BEGIN
        INSERT INTO work_canvas_revisions(canvas_name, revision)
        VALUES (NEW.canvas_name, 1)
        ON CONFLICT(canvas_name) DO UPDATE
          SET revision = work_canvas_revisions.revision + 1;
      END;

  CREATE TRIGGER work_canvas_revision_task_messages_update
      AFTER UPDATE ON work_task_messages
      BEGIN
        INSERT INTO work_canvas_revisions(canvas_name, revision)
        VALUES (NEW.canvas_name, 1)
        ON CONFLICT(canvas_name) DO UPDATE
          SET revision = work_canvas_revisions.revision + 1;
      END;

  CREATE TRIGGER work_task_messages_home_immutable
    BEFORE UPDATE OF entity_home ON work_task_messages
    WHEN OLD.entity_home <> NEW.entity_home
    BEGIN
      SELECT RAISE(ABORT, 'work task message home is immutable');
    END;

  CREATE TRIGGER work_task_messages_require_exact_parent
    BEFORE INSERT ON work_task_messages
    WHEN NOT (
      (
        NEW.parent_lane = 'task'
        AND EXISTS (
          SELECT 1
          FROM work_tasks
          WHERE canvas_name = NEW.canvas_name
            AND node_id = NEW.node_id
            AND task_id = NEW.item_id
            AND entity_home = NEW.entity_home
        )
      )
    )
    BEGIN
      SELECT RAISE(
        ABORT,
        'work task message requires an exact same-home parent'
      );
    END;
`;

const TASK_TRANSITIONS_SQL = `
  CREATE TABLE work_task_transitions (
      canvas_name TEXT NOT NULL CHECK (length(canvas_name) BETWEEN 1 AND 256),
      node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
      item_id TEXT NOT NULL CHECK (length(item_id) BETWEEN 1 AND 256),
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      lane TEXT NOT NULL CHECK (lane IN ('task')),
      entity_home TEXT NOT NULL,
      actor_seat_id TEXT
        CHECK (
          actor_seat_id IS NULL
          OR (
            length(actor_seat_id) = 69
            AND substr(actor_seat_id, 1, 5) = 'seat_'
            AND substr(actor_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
          )
        ),
      fact_event_home TEXT NOT NULL,
      fact_entity_home TEXT NOT NULL,
      fact_seq TEXT NOT NULL,
      operation TEXT NOT NULL
        CHECK (
          operation IN (
            'task.create',
            'task.describe',
            'task.transition',
            'task.claim'
          )
        ),
      from_state TEXT,
      to_state TEXT NOT NULL
        CHECK (
          to_state IN (
            'submitted',
            'working',
            'input-required',
            'auth-required',
            'completed',
            'canceled',
            'failed',
            'rejected',
            'archived'
          )
        ),
      origin_at TEXT NOT NULL CHECK (length(origin_at) BETWEEN 1 AND 64),
      received_at TEXT NOT NULL CHECK (length(received_at) BETWEEN 1 AND 64),
      PRIMARY KEY (canvas_name, node_id, item_id, lane, ordinal),
      UNIQUE (fact_event_home, fact_entity_home, fact_seq),
      CHECK (
        from_state IS NULL
        OR from_state IN (
          'submitted',
          'working',
          'input-required',
          'auth-required',
          'completed',
          'canceled',
          'failed',
          'rejected',
          'archived'
        )
      ),
      CHECK (
        to_state NOT IN ('working', 'input-required', 'auth-required')
        OR actor_seat_id IS NOT NULL
      ),
      CHECK (entity_home = fact_entity_home),
      CHECK (fact_event_home = fact_entity_home),
      FOREIGN KEY (entity_home)
        REFERENCES known_installations(installation_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT,
      FOREIGN KEY (fact_event_home, fact_entity_home, fact_seq)
        REFERENCES work_facts(event_home, entity_home, seq)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
    ) STRICT, WITHOUT ROWID;
`;

const TASK_TRANSITIONS_TRIGGERS_SQL = `
  CREATE TRIGGER work_task_transitions_home_immutable
    BEFORE UPDATE OF entity_home ON work_task_transitions
    WHEN OLD.entity_home <> NEW.entity_home
    BEGIN
      SELECT RAISE(ABORT, 'work transition home is immutable');
    END;
`;

const CONTENT_REFS_SQL = `
  CREATE TABLE content_refs (
      ref_id TEXT PRIMARY KEY
        CHECK (length(ref_id) BETWEEN 1 AND 256),
      sha256 TEXT NOT NULL
        CHECK (
          length(sha256) = 64
          AND sha256 NOT GLOB '*[^a-f0-9]*'
        ),
      byte_length INTEGER NOT NULL
        CHECK (
          typeof(byte_length) = 'integer'
          AND byte_length >= 0
        ),
      media_type TEXT NOT NULL
        CHECK (length(media_type) BETWEEN 1 AND 255),
      display_name TEXT
        CHECK (
          display_name IS NULL
          OR length(display_name) BETWEEN 1 AND 255
        ),
      owner_kind TEXT NOT NULL
        CHECK (
          owner_kind IN (
            'task',
            'message',
            'artifact',
            'other'
          )
        ),
      owner_canvas TEXT NOT NULL
        CHECK (length(owner_canvas) BETWEEN 1 AND 256),
      owner_node TEXT NOT NULL
        CHECK (length(owner_node) BETWEEN 1 AND 256),
      owner_record_id TEXT NOT NULL
        CHECK (length(owner_record_id) BETWEEN 1 AND 256),
      created_at TEXT NOT NULL
        CHECK (length(created_at) BETWEEN 1 AND 64),
      FOREIGN KEY (sha256)
        REFERENCES content_objects(sha256)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
    ) STRICT, WITHOUT ROWID;

  CREATE INDEX content_refs_by_object
      ON content_refs(sha256, created_at, ref_id);

  CREATE INDEX content_refs_by_owner
      ON content_refs(owner_canvas, owner_node, owner_kind, owner_record_id);
`;

const CONTENT_REFS_TRIGGERS_SQL = "";

type StoredRow = Record<string, string | number | null>;

const columnsOf = (database: StateSchemaMigrationDatabase, table: string): ReadonlyArray<string> =>
  (database.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all() as unknown as ReadonlyArray<{
    readonly name: string;
  }>).map(({ name }) => name);

/**
 * Rebuilds a table from its own text with the rows `keep` admits, changed by
 * `change`. Triggers are created after the copy, so none fires on it.
 */
const rebuild = (
  database: StateSchemaMigrationDatabase,
  table: string,
  shape: string,
  triggers: string,
  keep: string,
  change: (row: StoredRow) => StoredRow = (row) => row,
): void => {
  const columns = columnsOf(database, table);
  const stored = database
    .prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE ${keep}`)
    .all() as unknown as ReadonlyArray<StoredRow>;
  database.exec(`DROP TABLE ${table}`);
  database.exec(shape);
  const insert = database.prepare(
    `INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of stored.map(change)) insert.run(...columns.map((column) => row[column] ?? null));
  const kept = Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  if (kept !== stored.length) throw new Error(`a kept row of ${table} did not survive the step`);
  if (triggers) database.exec(triggers);
};

/** The mask without the retired ports, in the order it was stored. */
const withoutBoardPorts = (row: StoredRow): StoredRow => {
  if (typeof row.mask_json !== "string") return row;
  const ports: unknown = JSON.parse(row.mask_json);
  if (!Array.isArray(ports) || !ports.some((port) => RETIRED_PORTS.has(String(port)))) return row;
  return { ...row, mask_json: JSON.stringify(ports.filter((port) => !RETIRED_PORTS.has(String(port)))) };
};

const RETIRED_EVENT = `(SELECT event_home, entity_home, seq FROM work_events WHERE operation IN (${list(BOARD_REQUESTS_RETIRED_OPERATIONS)}))`;

const isRetiredFact = (prefix: string): string =>
  `(${prefix}event_home, ${prefix}entity_home, ${prefix}seq) IN ${RETIRED_EVENT}`;

/** Rows the step keeps, and the retired fact each would still name. */
const KEPT_REFERENCES = [
  ["work_facts", `NOT ${isRetiredFact("")} AND ${isRetiredFact("predecessor_")}`],
  ["work_messages", isRetiredFact("fact_")],
  ["work_tasks", isRetiredFact("fact_")],
  ["work_artifacts", isRetiredFact("fact_")],
  ["work_delivery_receipts", isRetiredFact("fact_")],
  ["work_task_messages", `parent_lane = 'task' AND ${isRetiredFact("fact_")}`],
  ["work_task_transitions", `lane = 'task' AND ${isRetiredFact("fact_")}`],
] as const;

/** Refuses the step, before anything moves, if a kept row names a retired fact. */
const refuseKeptReferences = (database: StateSchemaMigrationDatabase): void => {
  for (const [table, names] of KEPT_REFERENCES) {
    const n = Number(database.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${names}`).get()!.n);
    if (n > 0) throw new Error(`${n} kept row(s) of ${table} name a retired journal fact`);
  }
};

type StoredObject = { readonly type: string; readonly sql: string };

const storedObjects = (database: StateSchemaMigrationDatabase, table: string): ReadonlyArray<StoredObject> =>
  database
    .prepare(
      `SELECT type, sql FROM sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
    )
    .all(table) as unknown as ReadonlyArray<StoredObject>;

/**
 * The journal without its retired rows, each table recreated from the text it
 * was stored with. Facts go before their events, and the indexes and
 * triggers, among them the ones that forbid a delete, come back after the copy.
 */
export const rebuildJournal = (database: StateSchemaMigrationDatabase): void => {
  const events = storedObjects(database, "work_events");
  const facts = storedObjects(database, "work_facts");
  const keptEvents = `operation NOT IN (${list(BOARD_REQUESTS_RETIRED_OPERATIONS)})`;
  const keptFacts = `NOT ${isRetiredFact("")}`;
  const expected = {
    events: Number(database.prepare(`SELECT count(*) AS n FROM work_events WHERE ${keptEvents}`).get()!.n),
    facts: Number(database.prepare(`SELECT count(*) AS n FROM work_facts WHERE ${keptFacts}`).get()!.n),
  };
  database.exec(`
    CREATE TABLE work_events__migrate_bak AS SELECT * FROM work_events WHERE ${keptEvents};
    CREATE TABLE work_facts__migrate_bak AS SELECT * FROM work_facts WHERE ${keptFacts};
    DROP TABLE work_facts;
    DROP TABLE work_events;
  `);
  database.exec(events.find(({ type }) => type === "table")!.sql);
  database.exec(facts.find(({ type }) => type === "table")!.sql);
  const copy = (table: string): void => {
    const columns = columnsOf(database, table).join(", ");
    database.exec(`INSERT INTO ${table}(${columns}) SELECT ${columns} FROM ${table}__migrate_bak`);
  };
  copy("work_events");
  copy("work_facts");
  if (
    Number(database.prepare("SELECT count(*) AS n FROM work_events").get()!.n) !== expected.events ||
    Number(database.prepare("SELECT count(*) AS n FROM work_facts").get()!.n) !== expected.facts
  ) {
    throw new Error("a kept journal row did not survive the step");
  }
  database.exec("DROP TABLE work_facts__migrate_bak; DROP TABLE work_events__migrate_bak;");
  for (const { type, sql } of [...events, ...facts]) if (type !== "table") database.exec(sql);
};

const removedNodes = `(SELECT canvas_name, id FROM boards UNION ALL SELECT canvas_name, id FROM request_boards)`;

export const migrateBoardRequests = (database: StateSchemaMigrationDatabase): void => {
  refuseKeptReferences(database);

  rebuild(
    database,
    "wires",
    WIRES_SQL,
    WIRES_TRIGGERS_SQL,
    `verb NOT IN (${list(RETIRED_VERBS)})
      AND (canvas_name, from_id) NOT IN ${removedNodes}
      AND (canvas_name, to_id) NOT IN ${removedNodes}`,
    withoutBoardPorts,
  );
  rebuild(database, "work_task_messages", TASK_MESSAGES_SQL, TASK_MESSAGES_TRIGGERS_SQL, "parent_lane = 'task'");
  rebuild(database, "work_task_transitions", TASK_TRANSITIONS_SQL, TASK_TRANSITIONS_TRIGGERS_SQL, "lane = 'task'");
  rebuild(
    database,
    "content_refs",
    CONTENT_REFS_SQL,
    CONTENT_REFS_TRIGGERS_SQL,
    `owner_kind NOT IN (${list(RETIRED_OWNER_KINDS)})`,
  );
  for (const table of BOARD_REQUESTS_REMOVED_TABLES) database.exec(`DROP TABLE ${table}`);
  rebuildJournal(database);
};
