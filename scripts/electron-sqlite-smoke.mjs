import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = mkdtempSync(join(tmpdir(), "junto-electron-sqlite-"));
const stateDir = join(root, "state");
const databasePath = join(stateDir, "junto.db");
const backupPath = join(root, "junto.backup.db");

try {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);

  const database = new DatabaseSync(databasePath, {
    open: true,
    readOnly: false,
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowBareNamedParameters: false,
    allowUnknownNamedParameters: false,
    timeout: 5_000,
  });
  chmodSync(databasePath, 0o600);

  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE receipts (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE VIRTUAL TABLE receipt_search USING fts5(value);
    `);
    database.prepare(
      "INSERT INTO receipts(id, value) VALUES (?, ?)",
    ).run(1, "present");
    database.prepare(
      "INSERT INTO receipt_search(rowid, value) VALUES (?, ?)",
    ).run(1, "present");

    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      "INSERT INTO receipts(id, value) VALUES (?, ?)",
    ).run(2, "rolled-back");
    database.exec("ROLLBACK");

    database.prepare("VACUUM INTO ?").run(backupPath);
    chmodSync(backupPath, 0o600);

    const journalMode = database.prepare(
      "PRAGMA journal_mode",
    ).get()?.journal_mode;
    const synchronous = database.prepare(
      "PRAGMA synchronous",
    ).get()?.synchronous;
    const foreignKeys = database.prepare(
      "PRAGMA foreign_keys",
    ).get()?.foreign_keys;
    const integrity = database.prepare(
      "PRAGMA quick_check",
    ).get()?.quick_check;
    const fts = database.prepare(
      "SELECT rowid FROM receipt_search WHERE receipt_search MATCH ?",
    ).get("present")?.rowid;
    const rows = database.prepare(
      "SELECT count(*) AS count FROM receipts",
    ).get()?.count;

    if (
      journalMode !== "wal" ||
      synchronous !== 1 ||
      foreignKeys !== 1 ||
      integrity !== "ok" ||
      fts !== 1 ||
      rows !== 1
    ) {
      throw new Error("Electron SQLite invariants did not hold");
    }
  } finally {
    database.close();
  }

  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const receipt = backup.prepare(
      "SELECT value FROM receipts WHERE id = ?",
    ).get(1)?.value;
    if (receipt !== "present") {
      throw new Error("VACUUM INTO backup is not coherent");
    }
  } finally {
    backup.close();
  }

  if (
    (lstatSync(stateDir).mode & 0o777) !== 0o700 ||
    (lstatSync(databasePath).mode & 0o777) !== 0o600 ||
    (lstatSync(backupPath).mode & 0o777) !== 0o600
  ) {
    throw new Error("Electron SQLite files are not private");
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      electron: process.versions.electron,
      node: process.versions.node,
      sqlite: process.versions.sqlite,
      fts5: true,
      backup: true,
    })}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
