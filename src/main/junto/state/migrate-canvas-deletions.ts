import type { StateSchemaMigrationDatabase } from "./migrations";

/**
 * The 0.10 deletions step. Kinds, verbs and features that 0.10 deletes leave
 * the database here, in one consolidate step:
 *
 * - every node of a removed kind goes with its kind's table, and so does
 *   every wire that touches one;
 * - every wire whose verb is not kept goes, `feeds` is stored as `flows`, and
 *   the `wires.verb` CHECK names only the kept verbs;
 * - the tables of removed features go;
 * - Hermes leaves the machine list, a remote machine's capabilities become
 *   terminals only, and pages and regions stop naming a machine (R5).
 *
 * Nothing else moves. The DDL below is this step's own copy. It never follows
 * the head schema.
 */

/** Node tables of removed kinds, children before parents. */
export const CANVAS_DELETIONS_REMOVED_KIND_TABLES = [
  // Pad and sheet kinds (09, 05): no node of either exists on a live canvas.
  "sheet_grids",
  "sheets",
  "pads",
] as const;

/** Feature tables with no successor, children before parents. */
export const CANVAS_DELETIONS_REMOVED_FEATURE_TABLES = [
  // Pad contents. The live canvas holds some for pads whose nodes are gone.
  "work_pad_posts",
  "work_pad_pins",
  "work_pad_images",
  "work_pad_shapes",
  "work_pad_edges",
  "work_pad_inks",
  "work_pad_read_cursors",
  "work_pad_meta",
  // Region Pulse (07).
  "kernel_armed_regions",
  "kernel_debug_pulses",
] as const;

export const CANVAS_DELETIONS_REMOVED_TABLES = [
  ...CANVAS_DELETIONS_REMOVED_KIND_TABLES,
  ...CANVAS_DELETIONS_REMOVED_FEATURE_TABLES,
] as const;

/** Verbs a wire may still say after this step, with the name each is stored under. */
const KEPT_VERBS = {
  messages: "messages",
  reviews: "reviews",
  navigates: "navigates",
  feeds: "flows",
} as const;

const WIRES_V26_SQL = `
  CREATE TABLE IF NOT EXISTS wires (
    canvas_name TEXT NOT NULL REFERENCES canvases(canvas_name) ON UPDATE CASCADE,
    id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    verb TEXT NOT NULL CHECK (verb IN ('messages', 'reviews', 'navigates', 'flows')),
    from_side TEXT CHECK (from_side IN ('top', 'right', 'bottom', 'left')),
    to_side TEXT CHECK (to_side IN ('top', 'right', 'bottom', 'left')),
    mask_json TEXT CHECK (mask_json IS NULL OR json_valid(mask_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (canvas_name, id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS wires_from ON wires(canvas_name, from_id, id);
  CREATE INDEX IF NOT EXISTS wires_to ON wires(canvas_name, to_id, id);
`;

const geometry = `
  canvas_name TEXT NOT NULL REFERENCES canvases(canvas_name) ON UPDATE CASCADE,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL CHECK (width > 0),
  height REAL NOT NULL CHECK (height > 0),
  z_index INTEGER NOT NULL,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL`;

const nodeTable = (name: string, fields: string): string => `
  CREATE TABLE IF NOT EXISTS ${name} (
    ${geometry},
    ${fields},
    PRIMARY KEY (canvas_name, id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS ${name}_canvas_order ON ${name}(canvas_name, z_index, id);
`;

/** Regions without `page_host`: a page lives on the browser's machine (R5). */
const REGIONS_V26_SQL = nodeTable(
  "regions",
  `
    label TEXT,
    hold INTEGER NOT NULL CHECK (hold IN (0, 1)),
    instruction TEXT,
    page_url TEXT,
    page_profile TEXT,
    paths_json TEXT CHECK (paths_json IS NULL OR json_valid(paths_json)),
    rules_json TEXT CHECK (rules_json IS NULL OR json_valid(rules_json)),
    rulings_json TEXT CHECK (rulings_json IS NULL OR json_valid(rulings_json)),
    environment_json TEXT CHECK (environment_json IS NULL OR json_valid(environment_json)),
    background TEXT,
    background_style TEXT CHECK (background_style IN ('cover', 'ratio', 'repeat'))`,
);

/** Pages without `host`, for the same reason. */
const PAGES_V26_SQL = nodeTable(
  "pages",
  `
    url TEXT NOT NULL,
    profile TEXT NOT NULL,
    on_remove TEXT NOT NULL CHECK (on_remove IN ('detach', 'kill-session'))`,
);

/**
 * The machine list without Hermes (R5): no Hermes identity, and a remote
 * machine's capability mask is terminals only.
 */
const HOST_REGISTRY_V26_SQL = `
  CREATE TABLE host_registry (
    id TEXT PRIMARY KEY CHECK (
      length(id) BETWEEN 1 AND 64
      AND substr(id, 1, 1) GLOB '[A-Za-z0-9]'
      AND id NOT GLOB '*[^A-Za-z0-9._-]*'
      AND id <> 'local'
    ),
    label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
    is_this_machine INTEGER NOT NULL CHECK (is_this_machine IN (0, 1)),
    ssh_endpoint TEXT,
    ssh_port INTEGER CHECK (ssh_port IS NULL OR ssh_port BETWEEN 1 AND 65535),
    ssh_known_hosts_file TEXT CHECK (
      ssh_known_hosts_file IS NULL OR (
        length(ssh_known_hosts_file) BETWEEN 1 AND 1024
        AND substr(ssh_known_hosts_file, 1, 1) = '/'
        AND ssh_known_hosts_file NOT GLOB '*[^A-Za-z0-9._/@+-]*'
      )
    ),
    ssh_host_key_alias TEXT CHECK (
      ssh_host_key_alias IS NULL OR (
        length(ssh_host_key_alias) BETWEEN 1 AND 255
        AND substr(ssh_host_key_alias, 1, 1) GLOB '[A-Za-z0-9]'
        AND ssh_host_key_alias NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    ),
    junto_home TEXT CHECK (junto_home IS NULL OR (length(junto_home) BETWEEN 1 AND 2048 AND substr(junto_home, 1, 1) = '/')),
    install_root TEXT CHECK (install_root IS NULL OR (length(install_root) BETWEEN 1 AND 2048 AND substr(install_root, 1, 1) = '/')),
    ssh_identity_file TEXT CHECK (
      ssh_identity_file IS NULL OR (
        length(ssh_identity_file) BETWEEN 1 AND 1024
        AND substr(ssh_identity_file, 1, 1) = '/'
      )
    ),
    ssh_host_key_policy TEXT CHECK (
      ssh_host_key_policy IS NULL OR ssh_host_key_policy IN ('system', 'accept-new')
    ),
    capability_mask INTEGER,
    appearance_color TEXT,
    appearance_glyph TEXT,
    sort_order INTEGER NOT NULL UNIQUE CHECK (sort_order >= 0),
    CHECK (
      (is_this_machine = 1 AND sort_order = 0 AND capability_mask IS NULL
        AND ssh_endpoint IS NULL AND ssh_identity_file IS NULL AND ssh_host_key_policy IS NULL
        AND junto_home IS NULL AND install_root IS NULL
        AND ssh_port IS NULL AND ssh_known_hosts_file IS NULL AND ssh_host_key_alias IS NULL)
      OR
      (is_this_machine = 0 AND sort_order > 0 AND capability_mask = 1
        AND (ssh_endpoint IS NULL OR length(ssh_endpoint) BETWEEN 1 AND 255)
        AND (ssh_endpoint IS NOT NULL OR (ssh_identity_file IS NULL AND ssh_host_key_policy IS NULL
          AND ssh_port IS NULL AND ssh_known_hosts_file IS NULL AND ssh_host_key_alias IS NULL))
        AND (ssh_known_hosts_file IS NULL OR ssh_host_key_policy IS NULL OR ssh_host_key_policy = 'system'))
    )
  ) STRICT;

  CREATE UNIQUE INDEX host_registry_route_unique
    ON host_registry(ssh_endpoint, coalesce(ssh_port, 0)) WHERE ssh_endpoint IS NOT NULL;

  CREATE UNIQUE INDEX host_registry_one_own
    ON host_registry(is_this_machine) WHERE is_this_machine = 1;

  CREATE TRIGGER host_registry_require_own
  BEFORE INSERT ON host_registry
  WHEN NEW.is_this_machine = 0 AND NOT EXISTS (SELECT 1 FROM host_registry WHERE is_this_machine = 1)
  BEGIN SELECT RAISE(ABORT, 'this machine must be registered first'); END;

  CREATE TRIGGER host_registry_retain_own
  BEFORE DELETE ON host_registry WHEN OLD.is_this_machine = 1
  BEGIN SELECT RAISE(ABORT, 'cannot remove this machine'); END;

  CREATE TRIGGER host_registry_own_flag_immutable
  BEFORE UPDATE OF is_this_machine ON host_registry
  WHEN OLD.is_this_machine <> NEW.is_this_machine
  BEGIN SELECT RAISE(ABORT, 'machine ownership cannot change'); END;
`;

const GEOMETRY_COLUMNS = [
  "canvas_name", "id", "x", "y", "width", "height", "z_index", "color", "created_at", "updated_at",
] as const;

/** Every column each rebuilt table keeps, and the order rows are copied in. */
const KEPT = {
  regions: {
    columns: [
      ...GEOMETRY_COLUMNS, "label", "hold", "instruction", "page_url", "page_profile", "paths_json",
      "rules_json", "rulings_json", "environment_json", "background", "background_style",
    ],
    order: "canvas_name, id",
    sql: REGIONS_V26_SQL,
  },
  pages: {
    columns: [...GEOMETRY_COLUMNS, "url", "profile", "on_remove"],
    order: "canvas_name, id",
    sql: PAGES_V26_SQL,
  },
  // This machine first: a remote row is refused until it exists.
  host_registry: {
    columns: [
      "id", "label", "is_this_machine", "ssh_endpoint", "ssh_port", "ssh_known_hosts_file",
      "ssh_host_key_alias", "junto_home", "install_root", "ssh_identity_file", "ssh_host_key_policy",
      "capability_mask", "appearance_color", "appearance_glyph", "sort_order",
    ],
    order: "is_this_machine DESC, sort_order",
    sql: HOST_REGISTRY_V26_SQL,
  },
} as const;

export const CANVAS_DELETIONS_RETIRED_COLUMNS = {
  regions: ["page_host"],
  pages: ["host"],
  host_registry: ["hermes_id", "effective_hermes_id"],
} as const;

type StoredRow = Record<string, string | number | null>;

/** Terminals are the one capability a remote machine still has; Hermes and the browser bits go. */
const remoteCapabilities = (row: StoredRow): StoredRow =>
  row.is_this_machine === 1 ? row : { ...row, capability_mask: 1 };

const rebuild = (
  database: StateSchemaMigrationDatabase,
  name: keyof typeof KEPT,
  change: (row: StoredRow) => StoredRow = (row) => row,
): void => {
  const { columns, order, sql } = KEPT[name];
  const stored = database
    .prepare(`SELECT ${columns.join(", ")} FROM ${name} ORDER BY ${order}`)
    .all() as unknown as ReadonlyArray<StoredRow>;

  database.exec(`DROP TABLE ${name}`);
  database.exec(sql);
  const insert = database.prepare(
    `INSERT INTO ${name}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of stored.map(change)) insert.run(...columns.map((column) => row[column] ?? null));
  const kept = Number(database.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n);
  if (kept !== stored.length) throw new Error(`a row of ${name} did not survive the step`);
};

const WIRE_COLUMNS = [
  "canvas_name", "id", "from_id", "to_id", "verb", "from_side", "to_side",
  "mask_json", "created_at", "updated_at",
] as const;

type WireRow = Readonly<Record<(typeof WIRE_COLUMNS)[number], string | number | null>>;

const keptVerb = (verb: unknown): string | undefined =>
  Object.hasOwn(KEPT_VERBS, String(verb)) ? KEPT_VERBS[String(verb) as keyof typeof KEPT_VERBS] : undefined;

/** `canvas_name` and `id` of every node held in a removed kind's table. */
const removedNodeKeys = (database: StateSchemaMigrationDatabase): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const table of CANVAS_DELETIONS_REMOVED_KIND_TABLES) {
    if (table === "sheet_grids") continue;
    const rows = database.prepare(`SELECT canvas_name, id FROM ${table}`).all() as unknown as ReadonlyArray<{
      readonly canvas_name: string;
      readonly id: string;
    }>;
    for (const row of rows) keys.add(JSON.stringify([row.canvas_name, row.id]));
  }
  return keys;
};

/** Copies forward every wire that keeps its verb and both of its ends. */
const rebuildWires = (database: StateSchemaMigrationDatabase, removedNodes: ReadonlySet<string>): void => {
  const stored = database
    .prepare(`SELECT ${WIRE_COLUMNS.join(", ")} FROM wires ORDER BY canvas_name, id`)
    .all() as unknown as ReadonlyArray<WireRow>;
  const kept = stored.flatMap((row) => {
    const verb = keptVerb(row.verb);
    const touchesRemoved =
      removedNodes.has(JSON.stringify([row.canvas_name, row.from_id])) ||
      removedNodes.has(JSON.stringify([row.canvas_name, row.to_id]));
    return verb === undefined || touchesRemoved ? [] : [{ ...row, verb }];
  });

  database.exec("DROP TABLE wires");
  database.exec(WIRES_V26_SQL);
  const insert = database.prepare(
    `INSERT INTO wires(${WIRE_COLUMNS.join(", ")}) VALUES (${WIRE_COLUMNS.map(() => "?").join(", ")})`,
  );
  for (const row of kept) insert.run(...WIRE_COLUMNS.map((column) => row[column]));
  const count = Number(database.prepare("SELECT count(*) AS n FROM wires").get()!.n);
  if (count !== kept.length) throw new Error("a kept wire did not survive the step");
};

export const migrateCanvasDeletions = (database: StateSchemaMigrationDatabase): void => {
  rebuildWires(database, removedNodeKeys(database));
  for (const table of CANVAS_DELETIONS_REMOVED_TABLES) database.exec(`DROP TABLE ${table}`);
  rebuild(database, "regions");
  rebuild(database, "pages");
  rebuild(database, "host_registry", remoteCapabilities);
};

/** The tables this step rebuilds in place. */
export const CANVAS_DELETIONS_REPLACED_TABLES = ["wires", "regions", "pages", "host_registry"] as const;
