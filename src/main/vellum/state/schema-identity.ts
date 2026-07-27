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

export type VerifiedStateSchemaIdentity = {
  readonly actualSchemaSha256: string;
  readonly sourceSchemaSha256: string;
};

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

/**
 * Prove that the live transaction contains exactly the current composed
 * schema, then stamp that proof. The expected connection is transient and
 * in-memory; it never reads or owns product state.
 */
export const verifyAndStampStateSchema = (
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

  const sourceSchemaSha256 = sha256(schemaSql);
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
      actualSchemaSha256,
      sourceSchemaSha256,
      new Date().toISOString(),
    );

  return { actualSchemaSha256, sourceSchemaSha256 };
};
