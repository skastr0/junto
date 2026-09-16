import { createHash } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

type SchemaObjectRow = {
  readonly type: SQLOutputValue;
  readonly name: SQLOutputValue;
  readonly table_name: SQLOutputValue;
  readonly sql: SQLOutputValue;
};

type SchemaObject = {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
};

/**
 * Schema identity is the fingerprint of the live SQLite shape (tables,
 * indexes, views, triggers). Nothing else.
 */
export type VerifiedStateSchemaIdentity = {
  readonly actualSchemaSha256: string;
};

export type RecordedStateSchemaIdentity =
  VerifiedStateSchemaIdentity & {
    readonly verifiedAt: string;
  };

/**
 * Expand-only retained column on `state_schema_identity`. Historical releases
 * wrote a source-SQL hash here; admission never uses it. New stamps write this
 * fixed sentinel so the NOT NULL column stays satisfied without dual identity.
 */
export const RETIRED_SOURCE_SCHEMA_SHA256 = "0".repeat(64);

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Tokenize stored DDL so formatting and keyword case are not schema identity.
 * Quoted values remain byte-exact because their whitespace and case can be
 * semantic (CHECK expressions and trigger messages in particular).
 */
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

const schemaObjects = (database: DatabaseSync): ReadonlyArray<SchemaObject> =>
  (
    database
      .prepare(
        `
          SELECT type, name, tbl_name AS table_name, sql
          FROM sqlite_schema
          WHERE type IN ('table', 'index', 'view', 'trigger')
            AND name NOT GLOB 'sqlite_*'
          ORDER BY type COLLATE BINARY, name COLLATE BINARY
        `,
      )
      .all() as SchemaObjectRow[]
  ).map((row) => ({
    type: String(row.type),
    name: String(row.name),
    tableName: String(row.table_name),
    sql: row.sql === null ? null : normalizeSchemaSql(String(row.sql)),
  }));

const schemaFingerprint = (
  objects: ReadonlyArray<SchemaObject>,
): string => sha256(JSON.stringify(objects));

export const actualStateSchemaSha256 = (
  database: DatabaseSync,
): string => schemaFingerprint(schemaObjects(database));

/**
 * A database is fresh only when the authority schema has no application-owned
 * objects. SQLite's own implementation objects are deliberately ignored: they
 * are not Junto state and their presence must not turn bootstrap into a
 * migration or repair path.
 */
export const isFreshStateSchema = (database: DatabaseSync): boolean =>
  schemaObjects(database).length === 0;

const schemaObjectKey = (object: SchemaObject): string =>
  `${object.type}:${object.name}`;

const describeMismatch = (
  actual: ReadonlyArray<SchemaObject>,
  expected: ReadonlyArray<SchemaObject>,
): string => {
  const actualByKey = new Map(
    actual.map((object) => [schemaObjectKey(object), object]),
  );
  const expectedByKey = new Map(
    expected.map((object) => [schemaObjectKey(object), object]),
  );
  const unexpected = [...actualByKey.keys()]
    .filter((key) => !expectedByKey.has(key))
    .sort();
  const missing = [...expectedByKey.keys()]
    .filter((key) => !actualByKey.has(key))
    .sort();
  const changed = [...expectedByKey.keys()]
    .filter((key) => {
      const actualObject = actualByKey.get(key);
      const expectedObject = expectedByKey.get(key);
      return actualObject !== undefined &&
        expectedObject !== undefined &&
        JSON.stringify(actualObject) !== JSON.stringify(expectedObject);
    })
    .sort();
  return [
    unexpected.length > 0 ? `unexpected=${unexpected.join(",")}` : "",
    missing.length > 0 ? `missing=${missing.join(",")}` : "",
    changed.length > 0 ? `changed=${changed.join(",")}` : "",
  ].filter(Boolean).join("; ");
};

const compileExpectedSchema = (
  schemaSql: string,
): ReadonlyArray<SchemaObject> => {
  const expected = new DatabaseSync(":memory:", {
    open: true,
    readOnly: false,
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
  });
  try {
    expected.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
    `);
    expected.exec(schemaSql);
    return schemaObjects(expected);
  } finally {
    expected.close();
  }
};

export const expectedStateSchemaIdentity = (
  schemaSql: string,
): VerifiedStateSchemaIdentity => ({
  actualSchemaSha256: schemaFingerprint(
    compileExpectedSchema(schemaSql),
  ),
});

export const readRecordedStateSchemaIdentity = (
  database: DatabaseSync,
): RecordedStateSchemaIdentity => {
  const identityTable = database
    .prepare(
      `
        SELECT 1
        FROM sqlite_schema
        WHERE type = 'table'
          AND name = 'state_schema_identity'
      `,
    )
    .get();
  if (identityTable === undefined) {
    throw new Error("state schema identity table is missing");
  }
  const row = database
    .prepare(
      `
        SELECT
          actual_schema_sha256,
          verified_at
        FROM state_schema_identity
        WHERE singleton = 1
      `,
    )
    .get() as
      | {
          readonly actual_schema_sha256: SQLOutputValue;
          readonly verified_at: SQLOutputValue;
        }
      | undefined;
  if (row === undefined) {
    throw new Error("state schema identity witness is missing");
  }
  return {
    actualSchemaSha256: String(row.actual_schema_sha256),
    verifiedAt: String(row.verified_at),
  };
};

/**
 * Before a migration writes anything, prove that the live schema is exactly
 * the schema that the prior Junto release stamped. Version-specific
 * migration witnesses are checked by the migration runner after this.
 */
export const verifyRecordedStateSchemaIdentity = (
  database: DatabaseSync,
): RecordedStateSchemaIdentity => {
  const recorded = readRecordedStateSchemaIdentity(database);
  const actualSchemaSha256 = actualStateSchemaSha256(database);
  if (recorded.actualSchemaSha256 !== actualSchemaSha256) {
    throw new Error(
      "state schema changed after its recorded identity was stamped",
    );
  }
  return recorded;
};

export const stampStateSchemaIdentity = (
  database: DatabaseSync,
  identity: VerifiedStateSchemaIdentity,
): void => {
  database
    .prepare(
      `
        INSERT INTO state_schema_identity(
          singleton,
          actual_schema_sha256,
          source_schema_sha256,
          verified_at
        ) VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          actual_schema_sha256 = excluded.actual_schema_sha256,
          source_schema_sha256 = excluded.source_schema_sha256,
          verified_at = excluded.verified_at
      `,
    )
    .run(
      identity.actualSchemaSha256,
      RETIRED_SOURCE_SCHEMA_SHA256,
      new Date().toISOString(),
    );
};

/**
 * Prove that the live transaction contains exactly the current composed
 * schema. The expected connection is transient and in-memory; it never reads
 * or owns product state.
 */
export const verifyStateSchema = (
  database: DatabaseSync,
  schemaSql: string,
): VerifiedStateSchemaIdentity => {
  const expectedObjects = compileExpectedSchema(schemaSql);
  const actualObjects = schemaObjects(database);
  const expectedSchemaSha256 = schemaFingerprint(expectedObjects);
  const actualSchemaSha256 = schemaFingerprint(actualObjects);
  if (actualSchemaSha256 !== expectedSchemaSha256) {
    const detail = describeMismatch(actualObjects, expectedObjects);
    throw new Error(
      `state schema identity mismatch${
        detail.length > 0 ? ` (${detail})` : ""
      }`,
    );
  }

  return { actualSchemaSha256 };
};

export const verifyAndStampStateSchema = (
  database: DatabaseSync,
  schemaSql: string,
): VerifiedStateSchemaIdentity => {
  const identity = verifyStateSchema(database, schemaSql);
  stampStateSchemaIdentity(database, identity);
  return identity;
};
