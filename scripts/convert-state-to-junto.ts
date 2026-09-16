#!/usr/bin/env bun
/**
 * One-time local-state converter for the Junto rename.
 *
 * A pre-rename `vellum-command.db` (schema v18–v23 lineage) cannot be opened
 * by the Junto runtime: the work protocol literal, browser partition prefix,
 * stored harness ids, and durable metadata namespaces carry retired names,
 * and `state_schema_identity` fingerprints every live schema object, so
 * retired tables and drifted CHECK constraints must be reconciled to the
 * version-1 baseline rather than left in place.
 *
 * Usage: bun scripts/convert-state-to-junto.ts <path-to-junto.db>
 *
 * The script never deletes the source bytes: it copies the database to
 * `<path>.pre-rename` first, then converts the working file inside a single
 * transaction. Every row in retained tables is preserved; retired objects
 * that are not part of the version-1 schema are dropped (their rows remain
 * in the `.pre-rename` copy).
 */
import { copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import {
  persistCanvas,
  reconstructCanvasDoc,
  writePortfolioHead,
  type CanvasSqlWriter,
} from "../src/main/junto/canvas/records";
import {
  canvasBodySha256Of,
  intentSha256Of,
} from "../src/main/junto/canvas-intent-identity";
import { serializeCanvas } from "../src/shared/canvas";

// ---------------------------------------------------------------------------
// Minimal database interface — satisfied by bun:sqlite (CLI) and node:sqlite
// (unit tests under vitest) alike.
// ---------------------------------------------------------------------------

type SqlStatement = {
  run: (...params: never[]) => { readonly changes: number | bigint };
  get: (...params: never[]) => unknown;
  all: (...params: never[]) => unknown[];
};

type SqlDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqlStatement;
};

type Options = {
  /** Composed version-1 schema SQL (the conversion target). */
  readonly expectedSchemaSql: string;
  /** Opens an empty in-memory database of the same flavor as `db`. */
  readonly openMemoryDatabase: () => SqlDb;
  readonly now?: string;
};

// ---------------------------------------------------------------------------
// Canonical JSON + semantic hashing (mirrors src/shared/work-canonical-json.ts
// and src/main/junto/work/repository.ts; kept inline so the script stays a
// single self-contained unit runnable before the app is installed).
// ---------------------------------------------------------------------------

const canonicalJson = (value: unknown): string => {
  const normalizeJson = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalizeJson);
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v as Readonly<Record<string, unknown>>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, normalizeJson(nested)]),
    );
  };
  return JSON.stringify(normalizeJson(value));
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Schema fingerprint — mirrors src/main/junto/state/schema-identity.ts so the
// stamped identity is exactly what the runtime verifies on open.
// ---------------------------------------------------------------------------

type SchemaObject = {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  /** Normalized token form — comparison and fingerprinting only. */
  readonly sql: string | null;
  /** Stored DDL text — safe to execute for recreation. */
  readonly rawSql: string | null;
};

const normalizeSchemaSql = (sql: string): string => {
  const tokens: string[] = [];
  let index = 0;

  const pushQuoted = (opener: "'" | '"' | "`" | "["): void => {
    const closer = opener === "[" ? "]" : opener;
    let token = opener;
    index += 1;
    while (index < sql.length) {
      const character = sql[index]!;
      token += character;
      index += 1;
      if (character !== closer) continue;
      if (sql[index] === closer) {
        token += closer;
        index += 1;
        continue;
      }
      break;
    }
    tokens.push(token);
  };

  while (index < sql.length) {
    const character = sql[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (
      character === "'" ||
      character === '"' ||
      character === "`" ||
      character === "["
    ) {
      pushQuoted(character);
      continue;
    }

    const threeCharacters = sql.slice(index, index + 3);
    if (threeCharacters === "->>") {
      tokens.push(threeCharacters);
      index += 3;
      continue;
    }
    const twoCharacters = sql.slice(index, index + 2);
    if (
      [
        "||",
        "<<",
        ">>",
        "<=",
        ">=",
        "==",
        "!=",
        "<>",
        "->",
      ].includes(twoCharacters)
    ) {
      tokens.push(twoCharacters);
      index += 2;
      continue;
    }
    if (/[\[\]\(\),.;+\-*/%<>=!|&~]/u.test(character)) {
      tokens.push(character);
      index += 1;
      continue;
    }

    const start = index;
    while (
      index < sql.length &&
      !/[\s'"`\[\]\(\),.;+\-*/%<>=!|&~]/u.test(sql[index]!)
    ) {
      index += 1;
    }
    tokens.push(sql.slice(start, index).toLowerCase());
  }

  return JSON.stringify(tokens);
};

const schemaObjects = (db: SqlDb): ReadonlyArray<SchemaObject> =>
  (
    db
      .prepare(
        `
          SELECT type, name, tbl_name AS table_name, sql
          FROM sqlite_schema
          WHERE type IN ('table', 'index', 'view', 'trigger')
            AND name NOT GLOB 'sqlite_*'
          ORDER BY type COLLATE BINARY, name COLLATE BINARY
        `,
      )
      .all() as Array<{
        readonly type: unknown;
        readonly name: unknown;
        readonly table_name: unknown;
        readonly sql: unknown;
      }>
  ).map((row) => ({
    type: String(row.type),
    name: String(row.name),
    tableName: String(row.table_name),
    sql: row.sql === null ? null : normalizeSchemaSql(String(row.sql)),
    rawSql: row.sql === null ? null : String(row.sql),
  }));

const schemaFingerprint = (objects: ReadonlyArray<SchemaObject>): string =>
  sha256(
    JSON.stringify(
      objects.map((object) => ({
        type: object.type,
        name: object.name,
        tableName: object.tableName,
        sql: object.sql,
      })),
    ),
  );

// ---------------------------------------------------------------------------
// Work record reconstruction — mirrors the row layout produced by the work
// journal (work_events joined to its per-type body/variant table).
// ---------------------------------------------------------------------------

type RecordRow = {
  readonly event_home: string;
  readonly entity_home: string;
  readonly seq: string;
  readonly protocol: string;
  readonly record_type: string;
  readonly item_kind: string;
  readonly item_id: string;
  readonly item_canvas_name: string;
  readonly item_node_id: string;
  readonly operation: string;
  readonly content_sha256: string;
  readonly predecessor_event_home: string | null;
  readonly predecessor_entity_home: string | null;
  readonly predecessor_seq: string | null;
  readonly basis_kind: string | null;
  readonly basis_authorial_generation: string | null;
  readonly basis_authorial_content_sha256: string | null;
  readonly basis_projected_generation: string | null;
  readonly basis_projected_content_sha256: string | null;
  readonly basis_command_event_home: string | null;
  readonly basis_command_entity_home: string | null;
  readonly basis_command_seq: string | null;
  readonly basis_command_sha256: string | null;
  readonly status: string | null;
  readonly command_event_home: string | null;
  readonly command_entity_home: string | null;
  readonly command_seq: string | null;
  readonly command_sha256: string | null;
  readonly fact_event_home: string | null;
  readonly fact_entity_home: string | null;
  readonly fact_seq: string | null;
  readonly fact_sha256: string | null;
  readonly rejection_reason: string | null;
  readonly rejection_message: string | null;
  readonly action_json: string | null;
  readonly result_json: string | null;
};

const parseJson = (value: string | null): unknown =>
  value === null ? null : (JSON.parse(value) as unknown);

const predecessorOf = (row: RecordRow): unknown =>
  row.predecessor_seq === null
    ? null
    : {
        route: {
          eventHome: row.predecessor_event_home,
          entityHome: row.predecessor_entity_home,
        },
        seq: row.predecessor_seq,
      };

const basisOf = (row: RecordRow): unknown => {
  if (row.basis_kind === "authorial-intent") {
    return {
      kind: "authorial-intent",
      generation: row.basis_authorial_generation,
      contentSha256: row.basis_authorial_content_sha256,
    };
  }
  if (row.basis_kind === "projected-intent") {
    return {
      kind: "projected-intent",
      generation: row.basis_projected_generation,
      contentSha256: row.basis_projected_content_sha256,
    };
  }
  return {
    kind: "command",
    command: {
      route: {
        eventHome: row.basis_command_event_home,
        entityHome: row.basis_command_entity_home,
      },
      seq: row.basis_command_seq,
    },
    commandSha256: row.basis_command_sha256,
  };
};

const dispositionBodyOf = (row: RecordRow): unknown =>
  row.status === "applied"
    ? {
        status: "applied",
        command: {
          route: {
            eventHome: row.command_event_home,
            entityHome: row.command_entity_home,
          },
          seq: row.command_seq,
        },
        commandSha256: row.command_sha256,
        fact: {
          route: {
            eventHome: row.fact_event_home,
            entityHome: row.fact_entity_home,
          },
          seq: row.fact_seq,
        },
        factSha256: row.fact_sha256,
      }
    : {
        status: "rejected",
        command: {
          route: {
            eventHome: row.command_event_home,
            entityHome: row.command_entity_home,
          },
          seq: row.command_seq,
        },
        commandSha256: row.command_sha256,
        reason: row.rejection_reason,
        message: row.rejection_message,
      };

const recordSemanticOf = (row: RecordRow): unknown => {
  const common = {
    protocol: row.protocol,
    id: {
      route: {
        eventHome: row.event_home,
        entityHome: row.entity_home,
      },
      seq: row.seq,
    },
    recordType: row.record_type,
    item: {
      kind: row.item_kind,
      itemId: row.item_id,
      sink: {
        canvasName: row.item_canvas_name,
        nodeId: row.item_node_id,
      },
    },
    operation: row.operation,
  };
  switch (row.record_type) {
    case "command":
      return {
        ...common,
        predecessor: predecessorOf(row),
        body: parseJson(row.action_json),
      };
    case "fact":
      return {
        ...common,
        basis: basisOf(row),
        predecessor: predecessorOf(row),
        body: parseJson(row.result_json),
      };
    default:
      return { ...common, body: dispositionBodyOf(row) };
  }
};

const routeKey = (route: {
  eventHome: string;
  entityHome: string;
  seq: string;
}): string => `${route.eventHome} ${route.entityHome} ${route.seq}`;

const loadRecordRow = (
  db: SqlDb,
  route: { eventHome: string; entityHome: string; seq: string },
  recordType: "command" | "fact" | "disposition",
): RecordRow | undefined => {
  const variantColumns =
    recordType === "command"
      ? `predecessor_event_home, predecessor_entity_home, predecessor_seq,
         NULL AS basis_kind, NULL AS basis_authorial_generation,
         NULL AS basis_authorial_content_sha256, NULL AS basis_projected_generation,
         NULL AS basis_projected_content_sha256, NULL AS basis_command_event_home,
         NULL AS basis_command_entity_home, NULL AS basis_command_seq,
         NULL AS basis_command_sha256, NULL AS status, NULL AS command_event_home,
         NULL AS command_entity_home, NULL AS command_seq, NULL AS command_sha256,
         NULL AS fact_event_home, NULL AS fact_entity_home, NULL AS fact_seq,
         NULL AS fact_sha256, NULL AS rejection_reason, NULL AS rejection_message,
         action_json`
      : recordType === "fact"
        ? `predecessor_event_home, predecessor_entity_home, predecessor_seq,
           basis_kind, basis_authorial_generation, basis_authorial_content_sha256,
           basis_projected_generation, basis_projected_content_sha256,
           basis_command_event_home, basis_command_entity_home, basis_command_seq,
           basis_command_sha256, NULL AS status, NULL AS command_event_home,
           NULL AS command_entity_home, NULL AS command_seq, NULL AS command_sha256,
           NULL AS fact_event_home, NULL AS fact_entity_home, NULL AS fact_seq,
           NULL AS fact_sha256, NULL AS rejection_reason, NULL AS rejection_message,
           result_json`
        : `NULL AS predecessor_event_home, NULL AS predecessor_entity_home,
           NULL AS predecessor_seq, NULL AS basis_kind,
           NULL AS basis_authorial_generation, NULL AS basis_authorial_content_sha256,
           NULL AS basis_projected_generation, NULL AS basis_projected_content_sha256,
           NULL AS basis_command_event_home, NULL AS basis_command_entity_home,
           NULL AS basis_command_seq, NULL AS basis_command_sha256,
           status, command_event_home, command_entity_home, command_seq,
           command_sha256, fact_event_home, fact_entity_home, fact_seq,
           fact_sha256, rejection_reason, rejection_message,
           NULL AS action_json`;
  const table =
    recordType === "command"
      ? "work_commands"
      : recordType === "fact"
        ? "work_facts"
        : "work_dispositions";
  return db
    .prepare(
      `SELECT
         work_events.event_home, work_events.entity_home, work_events.seq,
         protocol, work_events.record_type, item_kind,
         item_id, item_canvas_name, item_node_id, operation, content_sha256,
         ${variantColumns}
       FROM work_events
       JOIN ${table} USING (event_home, entity_home, seq)
       WHERE event_home = ? AND entity_home = ? AND seq = ?`,
    )
    .get(
      route.eventHome as never,
      route.entityHome as never,
      route.seq as never,
    ) as RecordRow | undefined;
};

/**
 * Recompute `work_events.content_sha256` for every record and propagate each
 * changed hash to its correlated copies: `work_facts.basis_command_sha256`,
 * `work_dispositions.command_sha256`, and `work_dispositions.fact_sha256`.
 * Runs to a fixed point: a command hash that moved a fact's basis re-enters
 * the queue so the fact (and the dispositions that cite it) settle too.
 */
const repairWorkRecordHashes = (db: SqlDb): number => {
  const rows = db
    .prepare(
      `SELECT event_home, entity_home, seq, record_type
       FROM work_events`,
    )
    .all() as Array<{
      readonly event_home: string;
      readonly entity_home: string;
      readonly seq: string;
      readonly record_type: string;
    }>;

  type Pending = {
    readonly route: { eventHome: string; entityHome: string; seq: string };
    readonly recordType: "command" | "fact" | "disposition";
  };
  const pending: Pending[] = rows.map((row) => ({
    route: {
      eventHome: row.event_home,
      entityHome: row.entity_home,
      seq: row.seq,
    },
    recordType: row.record_type as Pending["recordType"],
  }));
  const queued = new Set(pending.map((p) => `${p.recordType}:${routeKey(p.route)}`));
  let rehashed = 0;

  const updateEventHash = db.prepare(
    "UPDATE work_events SET content_sha256 = ? WHERE event_home = ? AND entity_home = ? AND seq = ?",
  );
  const updateDispositionCommandSha = db.prepare(
    "UPDATE work_dispositions SET command_sha256 = ? WHERE command_event_home = ? AND command_entity_home = ? AND command_seq = ?",
  );
  const updateDispositionFactSha = db.prepare(
    "UPDATE work_dispositions SET fact_sha256 = ? WHERE fact_event_home = ? AND fact_entity_home = ? AND fact_seq = ?",
  );
  const updateFactBasisCommandSha = db.prepare(
    "UPDATE work_facts SET basis_command_sha256 = ? WHERE basis_command_event_home = ? AND basis_command_entity_home = ? AND basis_command_seq = ?",
  );
  const referentFacts = db.prepare(
    `SELECT event_home, entity_home, seq, basis_command_sha256 FROM work_facts
     WHERE basis_command_event_home = ? AND basis_command_entity_home = ? AND basis_command_seq = ?`,
  );
  const referentDispositionsByCommand = db.prepare(
    `SELECT event_home, entity_home, seq FROM work_dispositions
     WHERE command_event_home = ? AND command_entity_home = ? AND command_seq = ?`,
  );
  const referentDispositionsByFact = db.prepare(
    `SELECT event_home, entity_home, seq FROM work_dispositions
     WHERE fact_event_home = ? AND fact_entity_home = ? AND fact_seq = ?`,
  );
  const enqueue = (
    route: Pending["route"],
    recordType: Pending["recordType"],
  ): void => {
    const key = `${recordType}:${routeKey(route)}`;
    if (queued.has(key)) return;
    queued.add(key);
    pending.push({ route, recordType });
  };

  while (pending.length > 0) {
    const next = pending.shift()!;
    const row = loadRecordRow(db, next.route, next.recordType);
    if (row === undefined) {
      throw new Error(
        `convert-state-to-junto: ${next.recordType} record at ${routeKey(next.route)} is missing`,
      );
    }
    const computed = sha256(canonicalJson(recordSemanticOf(row)));
    if (computed === row.content_sha256) continue;
    updateEventHash.run(
      computed as never,
      row.event_home as never,
      row.entity_home as never,
      row.seq as never,
    );
    rehashed += 1;
    if (next.recordType === "command") {
      for (const fact of referentFacts.all(
        row.event_home as never,
        row.entity_home as never,
        row.seq as never,
      ) as Array<{
        readonly event_home: string;
        readonly entity_home: string;
        readonly seq: string;
        readonly basis_command_sha256: string | null;
      }>) {
        if (fact.basis_command_sha256 === computed) continue;
        updateFactBasisCommandSha.run(
          computed as never,
          row.event_home as never,
          row.entity_home as never,
          row.seq as never,
        );
        enqueue(
          {
            eventHome: fact.event_home,
            entityHome: fact.entity_home,
            seq: fact.seq,
          },
          "fact",
        );
      }
      for (const disposition of referentDispositionsByCommand.all(
        row.event_home as never,
        row.entity_home as never,
        row.seq as never,
      ) as Array<{
        readonly event_home: string;
        readonly entity_home: string;
        readonly seq: string;
      }>) {
        updateDispositionCommandSha.run(
          computed as never,
          row.event_home as never,
          row.entity_home as never,
          row.seq as never,
        );
        enqueue(
          {
            eventHome: disposition.event_home,
            entityHome: disposition.entity_home,
            seq: disposition.seq,
          },
          "disposition",
        );
      }
    } else if (next.recordType === "fact") {
      for (const disposition of referentDispositionsByFact.all(
        row.event_home as never,
        row.entity_home as never,
        row.seq as never,
      ) as Array<{
        readonly event_home: string;
        readonly entity_home: string;
        readonly seq: string;
      }>) {
        updateDispositionFactSha.run(
          computed as never,
          row.event_home as never,
          row.entity_home as never,
          row.seq as never,
        );
        enqueue(
          {
            eventHome: disposition.event_home,
            entityHome: disposition.entity_home,
            seq: disposition.seq,
          },
          "disposition",
        );
      }
    }
  }
  return rehashed;
};

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export type ConversionReport = {
  readonly tables: ReadonlyArray<{
    readonly name: string;
    readonly before: number;
    readonly after: number;
  }>;
  readonly rebuiltTables: readonly string[];
  readonly droppedObjects: readonly string[];
  readonly createdObjects: readonly string[];
  readonly rewrites: {
    readonly protocol: number;
    readonly browserPartition: number;
    readonly harnessId: number;
    readonly contextId: number;
    readonly tasksNamespace: number;
  };
  readonly rehashedRecords: number;
  readonly repairedCanvases: number;
  readonly repairedProjections: number;
  readonly userVersion: number;
  readonly schemaIdentitySha256: string;
};

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * Global substring rewrites applied to every TEXT value in every surviving
 * table — inside the rebuild SELECT for rebuilt tables (neither CHECK
 * generation tolerates the other's literals) and as UPDATEs elsewhere.
 * Ordered so no `to` value contains a later `from`.
 */
const COPY_REWRITE_PAIRS: ReadonlyArray<{
  readonly category: "protocol" | "browserPartition" | "harnessId";
  readonly from: string;
  readonly to: string;
}> = [
  { category: "protocol", from: "vellum/work/v2", to: "junto/work/v1" },
  {
    category: "protocol",
    from: "vellum-command-work/v1",
    to: "junto/work-control/v1",
  },
  {
    category: "protocol",
    from: "junto-work/v1",
    to: "junto/work-control/v1",
  },
  {
    category: "protocol",
    from: "vellum-work/v1",
    to: "junto/work-control/v1",
  },
  {
    category: "protocol",
    from: "vellum/station-control/v2",
    to: "junto/station-control/v1",
  },
  {
    category: "protocol",
    from: "vellum/station-control/v1",
    to: "junto/station-control/v1",
  },
  {
    category: "protocol",
    from: "vellum/station-api/v2",
    to: "junto/station-api/v1",
  },
  {
    category: "protocol",
    from: "vellum/station-api/v1",
    to: "junto/station-api/v1",
  },
  {
    category: "browserPartition",
    from: "persist:vellum-profile-",
    to: "persist:junto-profile-",
  },
  { category: "harnessId", from: "vellum-overseer", to: "junto-overseer" },
];

const tableColumns = (db: SqlDb, table: string): readonly string[] =>
  (
    db.prepare(`SELECT name FROM pragma_table_xinfo(?) ORDER BY cid`).all(
      table as never,
    ) as Array<{ readonly name: unknown }>
  ).map((column) => String(column.name));

const tableTextColumns = (db: SqlDb, table: string): readonly string[] =>
  (
    db.prepare(
      `SELECT name FROM pragma_table_xinfo(?)
       WHERE upper(type) LIKE '%TEXT%'
          OR upper(type) LIKE '%CHAR%'
          OR upper(type) LIKE '%CLOB%'
       ORDER BY cid`,
    ).all(table as never) as Array<{ readonly name: unknown }>
  ).map((column) => String(column.name));

const tableNames = (objects: ReadonlyArray<SchemaObject>): readonly string[] =>
  objects.filter((o) => o.type === "table").map((o) => o.name);

const rowCount = (db: SqlDb, table: string): number =>
  Number(
    (
      db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get() as {
        readonly n: unknown;
      }
    ).n,
  );

const escapeLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Nested `replace` expression applying every rewrite pair to a column value.
 * Used inside the rebuild copy so rows arrive already converted — the old
 * table's CHECK rejects the new literals and the new table's CHECK rejects
 * the old ones, so neither side can hold the intermediate state.
 */
const rewriteExpr = (column: string): string =>
  COPY_REWRITE_PAIRS.reduce(
    (expr, pair) =>
      `replace(${expr}, ${escapeLiteral(pair.from)}, ${escapeLiteral(pair.to)})`,
    quoteIdent(column),
  );

/**
 * Rebuild a table under its expected DDL, copying every row with the
 * literal rewrites applied to TEXT-affinity columns. The final table is
 * created by executing the expected stored text verbatim (not by RENAME)
 * so sqlite_schema keeps the canonical baseline bytes the identity
 * fingerprint verifies.
 */
const rebuildTable = (
  db: SqlDb,
  name: string,
  expectedSql: string,
  expectedColumns: readonly string[],
): void => {
  const actualColumns = new Set(tableColumns(db, name));
  const textColumns = new Set(tableTextColumns(db, name));
  const shared = expectedColumns.filter((column) => actualColumns.has(column));
  if (shared.length === 0) {
    throw new Error(
      `convert-state-to-junto: table ${name} shares no columns with the baseline`,
    );
  }
  const tmp = `${name}__junto_convert`;
  const tmpSql = expectedSql.replace(
    /CREATE TABLE( IF NOT EXISTS)? "?\w+"?/u,
    `CREATE TABLE ${quoteIdent(tmp)}`,
  );
  db.exec(tmpSql);
  const columnList = shared.map(quoteIdent).join(", ");
  const selectList = shared
    .map((column) =>
      textColumns.has(column)
        ? `CASE WHEN typeof(${quoteIdent(column)}) = 'text'
             THEN ${rewriteExpr(column)}
             ELSE ${quoteIdent(column)} END`
        : quoteIdent(column),
    )
    .join(", ");
  db.exec(
    `INSERT INTO ${quoteIdent(tmp)} (${columnList})
     SELECT ${selectList} FROM ${quoteIdent(name)}`,
  );
  db.exec(`DROP TABLE ${quoteIdent(name)}`);
  db.exec(expectedSql);
  db.exec(
    `INSERT INTO ${quoteIdent(name)} (${columnList})
     SELECT ${columnList} FROM ${quoteIdent(tmp)}`,
  );
  db.exec(`DROP TABLE ${quoteIdent(tmp)}`);
};

const dropObject = (db: SqlDb, object: SchemaObject): void => {
  const keyword =
    object.type === "table"
      ? "TABLE"
      : object.type === "index"
        ? "INDEX"
        : object.type === "view"
          ? "VIEW"
          : "TRIGGER";
  db.exec(`DROP ${keyword} IF EXISTS ${quoteIdent(object.name)}`);
};

/**
 * Rewrite an exact-column value (e.g. a bare `context_id` column) to its
 * replacement. Returns the number of rows touched.
 */
const rewriteExactColumn = (
  db: SqlDb,
  objects: ReadonlyArray<SchemaObject>,
  column: string,
  from: readonly string[],
  to: string,
  tables?: (name: string) => boolean,
): number => {
  let touched = 0;
  const list = from.map(() => "?").join(", ");
  for (const table of tableNames(objects)) {
    if (tables !== undefined && !tables(table)) continue;
    if (!tableColumns(db, table).includes(column)) continue;
    const result = db
      .prepare(
        `UPDATE ${quoteIdent(table)}
         SET ${quoteIdent(column)} = ?
         WHERE ${quoteIdent(column)} IN (${list})`,
      )
      .run(to as never, ...(from as never[]));
    touched += Number(result.changes);
  }
  return touched;
};

/** Row-counting counterpart to rewriteExactColumn. */
const countExactColumnRows = (
  db: SqlDb,
  objects: ReadonlyArray<SchemaObject>,
  column: string,
  from: readonly string[],
  tables?: (name: string) => boolean,
): number => {
  let counted = 0;
  const list = from.map(() => "?").join(", ");
  for (const table of tableNames(objects)) {
    if (tables !== undefined && !tables(table)) continue;
    if (!tableColumns(db, table).includes(column)) continue;
    counted += Number(
      (
        db
          .prepare(
            `SELECT count(*) AS n FROM ${quoteIdent(table)}
             WHERE ${quoteIdent(column)} IN (${list})`,
          )
          .get(...(from as never[])) as { readonly n: unknown }
      ).n,
    );
  }
  return counted;
};

/**
 * Rewrite one retired literal inside every TEXT column that carries it.
 * Returns the number of rows touched. `tables` limits the table scope;
 * `columns`, when given, limits the rewrite to those column names.
 */
const rewriteLiteral = (
  db: SqlDb,
  objects: ReadonlyArray<SchemaObject>,
  from: string,
  to: string,
  tables?: (name: string) => boolean,
  columns?: ReadonlySet<string>,
): number => {
  let touched = 0;
  for (const table of tableNames(objects)) {
    if (tables !== undefined && !tables(table)) continue;
    for (const column of tableColumns(db, table)) {
      if (columns !== undefined && !columns.has(column)) continue;
      const result = db
        .prepare(
          `UPDATE ${quoteIdent(table)}
           SET ${quoteIdent(column)} = replace(${quoteIdent(column)}, ?, ?)
           WHERE typeof(${quoteIdent(column)}) = 'text'
             AND instr(${quoteIdent(column)}, ?) > 0`,
        )
        .run(from as never, to as never, from as never);
      touched += Number(result.changes);
    }
  }
  return touched;
};

/**
 * Count the rows carrying a retired literal in any TEXT column — the
 * pre-conversion measurement for the report, since rows rebuilt through the
 * copy transform never pass through an UPDATE the runner can count.
 */
const countLiteralRows = (
  db: SqlDb,
  objects: ReadonlyArray<SchemaObject>,
  from: string,
  tables?: (name: string) => boolean,
  columns?: ReadonlySet<string>,
): number => {
  let counted = 0;
  for (const table of tableNames(objects)) {
    if (tables !== undefined && !tables(table)) continue;
    const textColumns = tableColumns(db, table).filter(
      (column) => columns === undefined || columns.has(column),
    );
    if (textColumns.length === 0) continue;
    const where = textColumns
      .map(
        (column) =>
          `(typeof(${quoteIdent(column)}) = 'text' AND instr(${quoteIdent(column)}, ?) > 0)`,
      )
      .join(" OR ");
    counted += Number(
      (
        db
          .prepare(
            `SELECT count(*) AS n FROM ${quoteIdent(table)} WHERE ${where}`,
          )
          .get(...(textColumns.map(() => from) as never[])) as {
          readonly n: unknown;
        }
      ).n,
    );
  }
  return counted;
};

const sqlWriter = (db: SqlDb): CanvasSqlWriter =>
  ({
    get: (sql: string, bindings?: readonly unknown[]) =>
      db.prepare(sql).get(...((bindings ?? []) as never[])),
    all: (sql: string, bindings?: readonly unknown[]) =>
      db.prepare(sql).all(...((bindings ?? []) as never[])),
    run: (sql: string, bindings?: readonly unknown[]) =>
      db.prepare(sql).run(...((bindings ?? []) as never[])),
  }) as unknown as CanvasSqlWriter;

/**
 * A rewritten `ether_json` changes the serialized canvas document, so the
 * document revision hash and the portfolio head are correlated hashes: each
 * changed canvas is reconstructed and persisted under its new revision, then
 * the head advances once with a recomputed intent hash — the same contract
 * the retired corrective converter used. The revision counter bumps the way
 * the projection-revision triggers would, so Stations re-sync the changed
 * canvas.
 */
const repairCanvasIdentity = (db: SqlDb, now: string): number => {
  const changed = db
    .prepare(
      `SELECT DISTINCT canvas_id FROM canvas_nodes
       WHERE ether_json LIKE '%junto-overseer%'
       UNION
       SELECT DISTINCT canvas_id FROM canvas_edges
       WHERE ether_json LIKE '%junto-overseer%'`,
    )
    .all() as Array<{ readonly canvas_id: unknown }>;
  if (changed.length === 0) return 0;
  const writer = sqlWriter(db);
  for (const row of changed) {
    const canvasId = String(row.canvas_id);
    const document = db
      .prepare(
        `SELECT canvas_name FROM canvas_documents WHERE canvas_id = ?`,
      )
      .get(canvasId as never) as { readonly canvas_name: unknown } | undefined;
    if (document === undefined) {
      throw new Error(
        `convert-state-to-junto: canvas row ${canvasId} has no document head`,
      );
    }
    const canvasName = String(document.canvas_name);
    const doc = reconstructCanvasDoc(writer, canvasId);
    const revisionSha256 = canvasBodySha256Of(serializeCanvas(doc));
    persistCanvas(writer, {
      canvasName,
      doc,
      revisionSha256,
      modifiedAt: now,
    });
    db.prepare(
      `INSERT INTO work_canvas_revisions(canvas_name, revision)
       VALUES (?, 1)
       ON CONFLICT(canvas_name) DO UPDATE
         SET revision = work_canvas_revisions.revision + 1`,
    ).run(canvasName as never);
  }

  const head = db
    .prepare(
      `SELECT generation, intent_sha256 FROM canvas_portfolio_head WHERE singleton = 1`,
    )
    .get() as
    | { readonly generation: unknown; readonly intent_sha256: unknown }
    | undefined;
  if (head === undefined) {
    throw new Error(
      "convert-state-to-junto: canvas changed but portfolio head is missing",
    );
  }
  const revisions = new Map<string, { readonly revisionSha256: string }>();
  for (const document of db
    .prepare(
      `SELECT canvas_name, revision_sha256 FROM canvas_documents ORDER BY canvas_name`,
    )
    .all() as Array<{
      readonly canvas_name: unknown;
      readonly revision_sha256: unknown;
    }>) {
    revisions.set(String(document.canvas_name), {
      revisionSha256: String(document.revision_sha256),
    });
  }
  writePortfolioHead(writer, {
    generation: (BigInt(String(head.generation)) + 1n).toString(),
    intentSha256: intentSha256Of(revisions),
    at: now,
  });
  return changed.length;
};

/**
 * Recompute `station_projection_versions.content_sha256` for every body the
 * rewrites touched (`sha256(body)` — the same contract the repository
 * verifies on decode) and remap every stored copy of the old hash:
 * `station_projection_head`, `work_facts.basis_projected_*`, and any
 * JSON-embedded reference.
 */
const repairProjectionHashes = (
  db: SqlDb,
  objects: () => ReadonlyArray<SchemaObject>,
): number => {
  const versions = db
    .prepare(
      `SELECT generation, content_sha256, body FROM station_projection_versions`,
    )
    .all() as Array<{
      readonly generation: unknown;
      readonly content_sha256: unknown;
      readonly body: unknown;
    }>;
  let repaired = 0;
  for (const row of versions) {
    const stored = String(row.content_sha256);
    const computed = sha256(String(row.body));
    if (computed === stored) continue;
    db.prepare(
      `UPDATE station_projection_versions SET content_sha256 = ? WHERE generation = ?`,
    ).run(computed as never, String(row.generation) as never);
    rewriteLiteral(db, objects(), stored, computed);
    repaired += 1;
  }
  return repaired;
};

export const convertStateToJunto = (
  db: SqlDb,
  options: Options,
): ConversionReport => {
  const expectedDb = options.openMemoryDatabase();
  let expectedObjects: ReadonlyArray<SchemaObject>;
  const expectedColumns = new Map<string, readonly string[]>();
  try {
    expectedDb.exec("PRAGMA foreign_keys = ON");
    expectedDb.exec(options.expectedSchemaSql);
    expectedObjects = schemaObjects(expectedDb);
    for (const object of expectedObjects) {
      if (object.type === "table") {
        expectedColumns.set(object.name, tableColumns(expectedDb, object.name));
      }
    }
  } finally {
    (expectedDb as { close?: () => void }).close?.();
  }
  const expectedByKey = new Map(
    expectedObjects.map((object) => [
      `${object.type}:${object.name}`,
      object,
    ]),
  );

  const beforeCounts = new Map(
    tableNames(schemaObjects(db)).map((name) => [name, rowCount(db, name)]),
  );

  const rebuiltTables: string[] = [];
  const droppedObjects: string[] = [];
  const createdObjects: string[] = [];

  // Foreign keys must be off before BEGIN so parent-table rebuilds can drop
  // and recreate a referenced table in one transaction.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    // 1. Triggers fire during conversion surgery (immutable-update guards on
    //    work facts would block the hash repair), and every drifted index or
    //    view must leave anyway: drop every non-table object now and recreate
    //    the baseline set after the data is final. Retired tables drop here.
    for (const object of schemaObjects(db)) {
      if (object.type !== "table") {
        dropObject(db, object);
        droppedObjects.push(`${object.type}:${object.name}`);
        continue;
      }
      if (expectedByKey.has(`table:${object.name}`)) continue;
      dropObject(db, object);
      droppedObjects.push(`table:${object.name}`);
    }

    // 2. Rewrite counts are measured now, before the rebuild copy and the
    //    UPDATE passes change anything — a row counts once per retired
    //    literal no matter how many columns carry it.
    const workTable = (name: string): boolean => name.startsWith("work_");
    const surviving = schemaObjects(db);
    const rewriteCounts = {
      protocol: COPY_REWRITE_PAIRS.filter(
        (pair) => pair.category === "protocol",
      ).reduce(
        (total, pair) => total + countLiteralRows(db, surviving, pair.from),
        0,
      ),
      browserPartition: countLiteralRows(
        db,
        surviving,
        "persist:vellum-profile-",
      ),
      harnessId: countLiteralRows(db, surviving, "vellum-overseer"),
      tasksNamespace: countLiteralRows(
        db,
        surviving,
        "vellum.tasks",
        workTable,
      ),
      contextId:
        ["Vellum", "VellumCommand", "Vellumcommand"].reduce(
          (total, retired) =>
            total +
            countLiteralRows(
              db,
              surviving,
              `"contextId":"${retired}"`,
              workTable,
            ) +
            countLiteralRows(
              db,
              surviving,
              `"contextId": "${retired}"`,
              workTable,
            ),
          0,
        ) +
        countExactColumnRows(
          db,
          surviving,
          "context_id",
          ["Vellum", "VellumCommand", "Vellumcommand"],
          workTable,
        ),
    };

    // 3. Tables whose stored DDL drifted (retired CHECK literals included):
    //    rebuild under the expected definition. The copy SELECT applies the
    //    global rewrites, so rows arrive already converted — neither CHECK
    //    generation can hold the intermediate state.
    for (const object of schemaObjects(db)) {
      if (object.type !== "table") continue;
      const expected = expectedByKey.get(`table:${object.name}`);
      if (expected === undefined || expected.rawSql === null) continue;
      if (object.sql === expected.sql) continue;
      rebuildTable(
        db,
        object.name,
        expected.rawSql,
        expectedColumns.get(object.name) ?? [],
      );
      rebuiltTables.push(object.name);
    }

    // 4. Baseline tables absent from the old database (defensive; the live
    //    pre-rename schema is a superset of the baseline).
    for (const object of expectedObjects) {
      if (object.type !== "table" || object.rawSql === null) continue;
      const actual = schemaObjects(db).find(
        (candidate) =>
          candidate.type === "table" && candidate.name === object.name,
      );
      if (actual !== undefined) continue;
      db.exec(object.rawSql);
      createdObjects.push(`table:${object.name}`);
    }

    // 5. Tables that kept their shape still carry retired values: apply the
    //    global pairs as UPDATEs, then the scoped rewrites — contextId inside
    //    work-domain bodies and bare columns, and the durable metadata key
    //    namespace anywhere in the work domain (metadata_json, parts_json,
    //    and embedded inside action/result bodies).
    const rebuilt = new Set(rebuiltTables);
    const notRebuilt = (name: string): boolean => !rebuilt.has(name);
    for (const pair of COPY_REWRITE_PAIRS) {
      rewriteLiteral(db, schemaObjects(db), pair.from, pair.to, notRebuilt);
    }
    rewriteLiteral(
      db,
      schemaObjects(db),
      "vellum.tasks",
      "junto.tasks",
      workTable,
    );
    for (const retired of ["Vellum", "VellumCommand", "Vellumcommand"]) {
      rewriteLiteral(
        db,
        schemaObjects(db),
        `"contextId":"${retired}"`,
        '"contextId":"Junto"',
        workTable,
      );
      rewriteLiteral(
        db,
        schemaObjects(db),
        `"contextId": "${retired}"`,
        '"contextId":"Junto"',
        workTable,
      );
    }
    rewriteExactColumn(
      db,
      schemaObjects(db),
      "context_id",
      ["Vellum", "VellumCommand", "Vellumcommand"],
      "Junto",
      workTable,
    );
    const rewrites = rewriteCounts;

    // 6. Correlated canvas identity: rewritten node/edge ether changes the
    //    serialized document, so revision hashes and the portfolio head move.
    const repairedCanvases = repairCanvasIdentity(
      db,
      options.now ?? new Date().toISOString(),
    );

    // 7. Correlated projection hashes: rewritten bodies move
    //    station_projection_versions.content_sha256 and every stored copy.
    const repairedProjections = repairProjectionHashes(db, () =>
      schemaObjects(db),
    );

    // 8. Correlated record hashes: every record changed protocol, and any
    //    body/basis rewrite moves its hash. Propagate to a fixed point.
    const rehashedRecords = repairWorkRecordHashes(db);

    // 9. Recreate the baseline's triggers, indexes, and views now that the
    //    data is final, then create-order the fingerprint check.
    for (const object of expectedObjects) {
      if (object.type === "table" || object.rawSql === null) continue;
      db.exec(object.rawSql);
      createdObjects.push(`${object.type}:${object.name}`);
    }

    // 10. Version and identity. The stamped fingerprint is computed over the
    //     expected object set, which must equal the live set after reconcile.
    const liveFingerprint = schemaFingerprint(schemaObjects(db));
    const expectedFingerprint = schemaFingerprint(expectedObjects);
    if (liveFingerprint !== expectedFingerprint) {
      throw new Error(
        "convert-state-to-junto: reconciled schema does not match the version-1 baseline",
      );
    }
    db.exec("PRAGMA user_version = 1");
    db.prepare(
      `INSERT INTO state_schema_identity(
         singleton, actual_schema_sha256, source_schema_sha256, verified_at
       ) VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         actual_schema_sha256 = excluded.actual_schema_sha256,
         source_schema_sha256 = excluded.source_schema_sha256,
         verified_at = excluded.verified_at`,
    ).run(
      expectedFingerprint as never,
      "0".repeat(64) as never,
      (options.now ?? new Date().toISOString()) as never,
    );

    // Deferred violations surface at COMMIT only for DEFERRABLE keys; check
    // explicitly while the transaction can still roll back.
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `convert-state-to-junto leaves ${violations.length} foreign-key violation(s): ${JSON.stringify(violations.slice(0, 5))}`,
      );
    }
    db.exec("COMMIT");
    const liveTables = new Set(tableNames(schemaObjects(db)));
    const report: ConversionReport = {
      tables: [...beforeCounts.entries()].map(([name, before]) => ({
        name,
        before,
        after: liveTables.has(name) ? rowCount(db, name) : 0,
      })),
      rebuiltTables,
      droppedObjects,
      createdObjects,
      rewrites,
      rehashedRecords,
      repairedCanvases,
      repairedProjections,
      userVersion: 1,
      schemaIdentitySha256: expectedFingerprint,
    };
    return report;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
};

const formatReport = (report: ConversionReport): string => {
  const lines = [
    "convert-state-to-junto",
    `  user_version: 1`,
    `  schema identity: ${report.schemaIdentitySha256}`,
    `  rebuilt tables: ${report.rebuiltTables.join(", ") || "none"}`,
    `  dropped objects: ${report.droppedObjects.length}`,
    `  created objects: ${report.createdObjects.length}`,
    `  rewrites:`,
    `    protocol values: ${report.rewrites.protocol}`,
    `    browser partitions: ${report.rewrites.browserPartition}`,
    `    harness ids: ${report.rewrites.harnessId}`,
    `    contextId values: ${report.rewrites.contextId}`,
    `    metadata namespace keys: ${report.rewrites.tasksNamespace}`,
    `  recomputed content hashes: ${report.rehashedRecords}`,
    `  rebuilt canvas identities: ${report.repairedCanvases}`,
    `  recomputed projection hashes: ${report.repairedProjections}`,
    `  row counts (before -> after):`,
    ...report.tables.map(
      (table) => `    ${table.name}: ${table.before} -> ${table.after}`,
    ),
  ];
  return lines.join("\n");
};

const isMain = process.argv[1]?.endsWith("convert-state-to-junto.ts") === true;

if (isMain) {
  const target = process.argv[2];
  if (target === undefined) {
    console.error("usage: bun scripts/convert-state-to-junto.ts <path-to-junto.db>");
    process.exit(1);
  }
  const backup = `${target}.pre-rename`;
  if (existsSync(backup)) {
    console.error(`backup ${backup} already exists; refusing to overwrite`);
    process.exit(1);
  }
  copyFileSync(target, backup);
  console.log(`copied ${target} -> ${backup}`);

  const { Database } = await import("bun:sqlite");
  const db = new Database(target) as unknown as SqlDb;
  try {
    const report = convertStateToJunto(db, {
      expectedSchemaSql: STATE_SCHEMA_SQL,
      openMemoryDatabase: () =>
        new Database(":memory:") as unknown as SqlDb,
    });
    console.log(formatReport(report));
  } finally {
    (db as { close?: () => void }).close?.();
  }
}
