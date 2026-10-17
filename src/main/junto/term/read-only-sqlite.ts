/**
 * One read of a harness's own SQLite database, strictly read-only: never
 * creates the file, never migrates it, never takes a write lock on a
 * database the operator's own harness is using. Any failure to open is
 * undefined, which callers read as "not found".
 */
import { DatabaseSync } from "node:sqlite";

export const withReadOnlyDatabase = <T>(
  path: string,
  read: (database: DatabaseSync) => T | undefined,
): T | undefined => {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      open: true,
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: 2_000,
    });
    return read(database);
  } catch {
    return undefined;
  } finally {
    try {
      database?.close();
    } catch {
      // best-effort
    }
  }
};
