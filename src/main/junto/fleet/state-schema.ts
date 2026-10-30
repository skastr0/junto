/**
 * One authority per canvas, held by quorum commit (0.11, 06 F6): what the
 * driver persists for the pure core in `consensus.ts`, in the order its
 * `ready()` asks, inside StateEngine transactions.
 *
 * - `canvas_consensus`, the core's hard state: term, vote and commit, plus
 *   the index this machine has applied through `foldRuling` (F2 advances it
 *   in the transaction that folds, so an entry is applied exactly once), the
 *   machine `junto authority alone` made sole voter, and when it last applied.
 * - `canvas_authorities`, the operator's ordered list as last committed. A
 *   list edit is a joint entry that lives only in the log until its final
 *   list commits; this table is written then.
 * - `canvas_log`, the entries by index. A ruling entry keeps the ruled
 *   command and its ruling as the queue and `resource_rulings` hold them, so
 *   the fold at commit and any machine that takes the entry need nothing
 *   else; a structure entry keeps the canvas count it changed to.
 * - `canvas_log_members`, a list entry's lists by position, never JSON.
 * - `canvas_log_waiting`, operator and structure entries an `alone` fork
 *   revoked: they wait for the operator to apply or discard, never dropped.
 *
 * Machine ids are installation ids. Added by state migration 60 -> 61.
 */
export const FLEET_CONSENSUS_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS canvas_consensus (
    canvas_name TEXT PRIMARY KEY
      REFERENCES canvases(canvas_name) ON DELETE CASCADE ON UPDATE CASCADE,
    current_term INTEGER NOT NULL CHECK (current_term >= 0),
    voted_for TEXT CHECK (voted_for IS NULL OR length(voted_for) BETWEEN 1 AND 128),
    commit_index INTEGER NOT NULL CHECK (commit_index >= 0),
    applied_index INTEGER NOT NULL CHECK (applied_index >= 0),
    sole_installation_id TEXT CHECK (sole_installation_id IS NULL OR length(sole_installation_id) BETWEEN 1 AND 128),
    last_applied_at_epoch_ms INTEGER CHECK (last_applied_at_epoch_ms IS NULL OR last_applied_at_epoch_ms >= 0)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS canvas_authorities (
    canvas_name TEXT NOT NULL
      REFERENCES canvases(canvas_name) ON DELETE CASCADE ON UPDATE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    installation_id TEXT NOT NULL CHECK (length(installation_id) BETWEEN 1 AND 128),
    PRIMARY KEY (canvas_name, position),
    UNIQUE (canvas_name, installation_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS canvas_log (
    canvas_name TEXT NOT NULL
      REFERENCES canvas_consensus(canvas_name) ON DELETE CASCADE ON UPDATE CASCADE,
    log_index INTEGER NOT NULL CHECK (log_index >= 1),
    term INTEGER NOT NULL CHECK (term >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('noop', 'list', 'ruling', 'structure.changed')),
    writer TEXT CHECK (writer IS NULL OR length(writer) BETWEEN 1 AND 256),
    op_id TEXT CHECK (op_id IS NULL OR length(op_id) = 26),
    command_json TEXT CHECK (command_json IS NULL OR json_valid(command_json)),
    ruling_json TEXT CHECK (ruling_json IS NULL OR json_valid(ruling_json)),
    structure_seq INTEGER CHECK (structure_seq IS NULL OR structure_seq >= 0),
    sole_installation_id TEXT CHECK (sole_installation_id IS NULL OR length(sole_installation_id) BETWEEN 1 AND 128),
    CHECK ((kind = 'ruling') = (writer IS NOT NULL AND op_id IS NOT NULL AND command_json IS NOT NULL AND ruling_json IS NOT NULL)),
    CHECK (kind = 'ruling' OR (writer IS NULL AND op_id IS NULL AND command_json IS NULL AND ruling_json IS NULL)),
    CHECK ((kind = 'structure.changed') = (structure_seq IS NOT NULL)),
    CHECK (kind = 'list' OR sole_installation_id IS NULL),
    PRIMARY KEY (canvas_name, log_index)
  ) STRICT, WITHOUT ROWID;

  CREATE UNIQUE INDEX IF NOT EXISTS canvas_log_ruling
    ON canvas_log(canvas_name, writer, op_id) WHERE kind = 'ruling';

  CREATE TABLE IF NOT EXISTS canvas_log_members (
    canvas_name TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('list', 'old')),
    position INTEGER NOT NULL CHECK (position >= 0),
    installation_id TEXT NOT NULL CHECK (length(installation_id) BETWEEN 1 AND 128),
    PRIMARY KEY (canvas_name, log_index, side, position),
    UNIQUE (canvas_name, log_index, side, installation_id),
    FOREIGN KEY (canvas_name, log_index) REFERENCES canvas_log(canvas_name, log_index) ON DELETE CASCADE ON UPDATE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS canvas_log_waiting (
    canvas_name TEXT NOT NULL
      REFERENCES canvases(canvas_name) ON DELETE CASCADE ON UPDATE CASCADE,
    log_index INTEGER NOT NULL CHECK (log_index >= 1),
    term INTEGER NOT NULL CHECK (term >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('ruling', 'structure.changed')),
    writer TEXT CHECK (writer IS NULL OR length(writer) BETWEEN 1 AND 256),
    op_id TEXT CHECK (op_id IS NULL OR length(op_id) = 26),
    command_json TEXT CHECK (command_json IS NULL OR json_valid(command_json)),
    structure_seq INTEGER CHECK (structure_seq IS NULL OR structure_seq >= 0),
    revoked_at_epoch_ms INTEGER NOT NULL CHECK (revoked_at_epoch_ms >= 0),
    CHECK ((kind = 'ruling') = (writer IS NOT NULL AND op_id IS NOT NULL AND command_json IS NOT NULL)),
    CHECK (kind = 'ruling' OR (writer IS NULL AND op_id IS NULL AND command_json IS NULL)),
    CHECK ((kind = 'structure.changed') = (structure_seq IS NOT NULL)),
    PRIMARY KEY (canvas_name, term, log_index)
  ) STRICT, WITHOUT ROWID;
`;

/**
 * The migration's snapshot: the log empty at term 1, nothing committed or
 * applied, and each canvas's editor its one authority, so nothing changes
 * until the operator lists a fallback. A canvas with no editor named is
 * edited here, as `canvasEdits` reads it, so this machine is its authority.
 * That holds by construction: NULL is written only for a canvas this machine
 * made (step 18's stamp, or createCanvas before the installation row exists),
 * and a copy taken in always names its editor (CanvasCopy.editor is an
 * InstallationId), so a replica's list is never this machine.
 */
export const FLEET_CONSENSUS_SEED_SQL = `
  INSERT INTO canvas_consensus (canvas_name, current_term, voted_for, commit_index, applied_index)
    SELECT canvas_name, 1, NULL, 0, 0 FROM canvases WHERE true
    ON CONFLICT (canvas_name) DO NOTHING;

  INSERT INTO canvas_authorities (canvas_name, position, installation_id)
    SELECT canvas_name, 0, editor
    FROM (
      SELECT canvas_name,
        COALESCE(editor_installation_id, (SELECT installation_id FROM installation WHERE singleton = 1)) AS editor
      FROM canvases
    )
    WHERE editor IS NOT NULL
    ON CONFLICT DO NOTHING;
`;

/**
 * Step 61's seed again, for every canvas that has no list: a home the engine
 * alone migrated has no installation row when the step runs (the app writes
 * it after), and a canvas created with the authority off gets no rows at all.
 * Run once the installation row exists and before any canvas opens its
 * authority; idempotent, statement by statement, in one transaction.
 */
export const FLEET_CONSENSUS_FILL_SQL = [
  `INSERT INTO canvas_consensus (canvas_name, current_term, voted_for, commit_index, applied_index)
    SELECT canvas_name, 1, NULL, 0, 0 FROM canvases
    WHERE NOT EXISTS (SELECT 1 FROM canvas_authorities a WHERE a.canvas_name = canvases.canvas_name)
    ON CONFLICT (canvas_name) DO NOTHING`,
  `INSERT INTO canvas_authorities (canvas_name, position, installation_id)
    SELECT canvas_name, 0, editor
    FROM (
      SELECT canvas_name,
        COALESCE(editor_installation_id, (SELECT installation_id FROM installation WHERE singleton = 1)) AS editor
      FROM canvases
      WHERE NOT EXISTS (SELECT 1 FROM canvas_authorities a WHERE a.canvas_name = canvases.canvas_name)
    )
    WHERE editor IS NOT NULL`,
] as const;

/**
 * A structure entry's change (0.11/06 F4): the nodes and wires it wrote and
 * the ones it removed, as the canvas command left them, so every listed
 * machine folds the entry without judging it again. One row per
 * `structure.changed` entry, going with it; a revoked one keeps its change
 * while it waits for the operator. Added by state migration 66 -> 67.
 */
export const FLEET_STRUCTURE_LOG_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS canvas_log_structure (
    canvas_name TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    change_json TEXT NOT NULL CHECK (json_valid(change_json)),
    PRIMARY KEY (canvas_name, log_index),
    FOREIGN KEY (canvas_name, log_index) REFERENCES canvas_log(canvas_name, log_index) ON DELETE CASCADE ON UPDATE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS canvas_log_waiting_structure (
    canvas_name TEXT NOT NULL,
    term INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    change_json TEXT NOT NULL CHECK (json_valid(change_json)),
    PRIMARY KEY (canvas_name, term, log_index),
    FOREIGN KEY (canvas_name, term, log_index) REFERENCES canvas_log_waiting(canvas_name, term, log_index) ON DELETE CASCADE ON UPDATE CASCADE
  ) STRICT, WITHOUT ROWID;
`;
