import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MAIL_READ_CACHE_SIZE_KIB, openMailReadDatabase } from "../src/main/junto/work/mail-read-worker";

let root: string;
let path: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "junto-mail-read-worker-"));
  path = join(root, "junto.db");
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1)");
  writer.close();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the mail read connection has a 64 MB page cache, no memory map, and cannot write", () => {
  const reader = openMailReadDatabase(path);
  try {
    expect(MAIL_READ_CACHE_SIZE_KIB).toBe(65536);
    expect(reader.prepare("PRAGMA cache_size").get()).toEqual({ cache_size: -65536 });
    expect(reader.prepare("PRAGMA mmap_size").get()).toEqual({ mmap_size: 0 });
    expect(reader.prepare("SELECT id FROM t").all()).toEqual([{ id: 1 }]);
    expect(() => reader.exec("INSERT INTO t VALUES (2)")).toThrow(/readonly/i);
  } finally {
    reader.close();
  }
});
