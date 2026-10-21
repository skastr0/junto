import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * A signal's files get an owner kind of their own (plan 02: signal
 * attachments cross as refs). Until this step they were held as
 * `{ other, signal:<signal id> }`, a kind every staged upload shares and a
 * prefix a reader would have to trust. This step rebuilds `content_refs`
 * with `signal` in its owner kind CHECK, and rewrites each such row to
 * `{ signal, <signal id> }` in the same copy. Every other row moves as it is.
 *
 * The step refuses, before anything moves, if an `other` row carries the
 * prefix with no signal id a signal could have (1 to 64 characters, the
 * `agent_signals.signal_id` CHECK). It keeps every row, and every index
 * and trigger the table had comes back by name. The DDL below is this step's
 * own copy. It never follows the head schema.
 */

export const SIGNAL_RECORD_PREFIX = "signal:";

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
            'other',
            'signal'
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

type StoredRow = Record<string, string | number | null>;

const COLUMNS = [
  "ref_id",
  "sha256",
  "byte_length",
  "media_type",
  "display_name",
  "owner_kind",
  "owner_canvas",
  "owner_node",
  "owner_record_id",
  "created_at",
] as const;

/** substr, not LIKE: the prefix is compared as text, with no pattern. */
const IS_SIGNAL_ROW = `owner_kind = 'other' AND substr(owner_record_id, 1, ${SIGNAL_RECORD_PREFIX.length}) = '${SIGNAL_RECORD_PREFIX}'`;

const sideObjects = (database: StateSchemaMigrationDatabase): ReadonlyArray<string> =>
  (database
    .prepare("SELECT type || ':' || name AS object FROM sqlite_schema WHERE tbl_name = 'content_refs' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY object")
    .all() as unknown as ReadonlyArray<{ readonly object: string }>).map(({ object }) => object);

/** The row as this step keeps it: a signal's file under its own kind and its signal id. */
export const signalOwnedRow = (row: StoredRow): StoredRow =>
  row.owner_kind === "other" && typeof row.owner_record_id === "string" && row.owner_record_id.startsWith(SIGNAL_RECORD_PREFIX)
    ? { ...row, owner_kind: "signal", owner_record_id: row.owner_record_id.slice(SIGNAL_RECORD_PREFIX.length) }
    : row;

export const migrateSignalContentOwner = (database: StateSchemaMigrationDatabase): void => {
  const unmapped = Number(
    database
      .prepare(`SELECT count(*) AS n FROM content_refs WHERE ${IS_SIGNAL_ROW} AND length(owner_record_id) NOT BETWEEN ${SIGNAL_RECORD_PREFIX.length + 1} AND ${SIGNAL_RECORD_PREFIX.length + 64}`)
      .get()!.n,
  );
  if (unmapped > 0) throw new Error(`${unmapped} content ref(s) held for a signal name no signal id`);
  const columns = (database.prepare("SELECT name FROM pragma_table_info('content_refs') ORDER BY cid").all() as unknown as ReadonlyArray<{ readonly name: string }>).map(({ name }) => name);
  if (columns.join(",") !== COLUMNS.join(",")) throw new Error("content_refs does not have the columns this step copies");
  const before = sideObjects(database);
  const stored = database
    .prepare(`SELECT ${COLUMNS.join(", ")} FROM content_refs`)
    .all() as unknown as ReadonlyArray<StoredRow>;
  database.exec("DROP TABLE content_refs");
  database.exec(CONTENT_REFS_SQL);
  const insert = database.prepare(`INSERT INTO content_refs(${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`);
  for (const row of stored.map(signalOwnedRow)) insert.run(...COLUMNS.map((column) => row[column] ?? null));
  const kept = Number(database.prepare("SELECT count(*) AS n FROM content_refs").get()!.n);
  if (kept !== stored.length) throw new Error("a content ref did not survive the step");
  const after = sideObjects(database);
  if (after.join("\n") !== before.join("\n")) throw new Error("the content refs did not get back every index and trigger they had");
  const left = Number(database.prepare(`SELECT count(*) AS n FROM content_refs WHERE ${IS_SIGNAL_ROW}`).get()!.n);
  if (left > 0) throw new Error("a content ref held for a signal kept the old owner");
};
