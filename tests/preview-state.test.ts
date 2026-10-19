import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { snapshotPreview } from "../scripts/preview-snapshot";
import { checkPreview } from "../scripts/preview-db-check";
import { pinFreshPreviewHome } from "../src/main/junto/preview-home";

const paths: string[] = [];
const temporary = () => { const p = mkdtempSync(join(tmpdir(), "junto-preview-test-")); paths.push(p); return p; };
afterEach(() => { for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true }); });

it("pins a packaged Finder launch to fresh state before product imports and refuses copied homes", () => {
  const home = temporary(), fresh = join(home, ".junto-preview");
  const environment = { JUNTO_HOME: home, JUNTO_HOME_OWNS_SESSIONS: "1", JUNTO_WORK_TOKEN: "live", JUNTO_WORK_HOME: "/live/work", JUNTO_WORK_SOCKET: "/live/work/control.sock" };
  expect(() => pinFreshPreviewHome(home, environment)).toThrow("fresh home");
  mkdirSync(fresh); writeFileSync(join(fresh, ".fresh-preview"), "fresh");
  pinFreshPreviewHome(home, environment);
  expect(environment).toEqual({ JUNTO_HOME: fresh, JUNTO_PREVIEW: "1", JUNTO_HOME_OWNS_SESSIONS: "1" });
  writeFileSync(join(fresh, "snapshot.json"), "{}");
  expect(() => pinFreshPreviewHome(home, environment)).toThrow("copied-state launch is refused");
});

it("admits a separate marked Preview home and refuses live, nested and linked homes", () => {
  const home = temporary(), fresh = join(home, ".junto-preview-machines");
  mkdirSync(fresh); writeFileSync(join(fresh, ".fresh-preview"), "fresh");
  const environment: NodeJS.ProcessEnv = { JUNTO_PREVIEW_HOME: fresh, JUNTO_WORK_TOKEN: "live", JUNTO_HOME: home };
  pinFreshPreviewHome(home, environment);
  expect(environment.JUNTO_HOME).toBe(fresh);
  expect(environment.JUNTO_WORK_TOKEN).toBeUndefined();
  pinFreshPreviewHome(home, environment);
  expect(environment.JUNTO_HOME).toBe(fresh);
  for (const invalid of [home, join(home, ".junto"), join(home, "nested/.junto-preview-machines")]) {
    expect(() => pinFreshPreviewHome(home, { JUNTO_PREVIEW_HOME: invalid })).toThrow("account home");
  }
  const linked = join(home, ".junto-preview-linked");
  symlinkSync(fresh, linked);
  expect(() => pinFreshPreviewHome(home, { JUNTO_PREVIEW_HOME: linked })).toThrow("fresh home");
});

it("backs up committed WAL without a checkpoint, retains a protected baseline and never follows live references", async () => {
  const root = temporary(), source = join(root, "source"), preview = join(root, "preview");
  mkdirSync(join(source, "state"), { recursive: true });
  mkdirSync(join(source, "term"));
  mkdirSync(join(source, "locks"));
  mkdirSync(join(source, "state", "credentials"));
  writeFileSync(join(source, "state", "credentials", "credential"), "private");
  writeFileSync(join(source, "term", "token"), "live-control");
  writeFileSync(join(source, "locks", "live"), "pid");
  symlinkSync(source, join(source, "live-reference"));
  const db = new DatabaseSync(join(source, "state", "junto.db"));
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE data(value TEXT); INSERT INTO data VALUES ('committed in WAL')");
    const wal = readFileSync(join(source, "state", "junto.db-wal"));
    const manifest = await snapshotPreview(source, preview);
    expect(readFileSync(join(source, "state", "junto.db-wal"))).toEqual(wal);
    const before = new DatabaseSync(join(preview, "before", "junto.db"), { readOnly: true });
    expect(before.prepare("SELECT value FROM data").get()?.value).toBe("committed in WAL");
    before.close();
    db.exec("INSERT INTO data VALUES ('later')");
    expect(manifest.omitted.some(row => row.path === "live-reference")).toBe(true);
    expect(existsSync(join(preview, ".junto", "term", "token"))).toBe(false);
    expect(existsSync(join(preview, ".junto", "locks"))).toBe(false);
    expect(statSync(preview).mode & 0o777).toBe(0o700);
    expect(statSync(join(preview, "before", "junto.db")).mode & 0o777).toBe(0o400);
    expect(readFileSync(join(preview, ".junto", "state", "credentials", "credential"), "utf8")).toBe("private");
    await expect(snapshotPreview(source, preview)).rejects.toThrow("overwrite");
    await expect(snapshotPreview(source, join(source, "inside"))).rejects.toThrow("separate");
  } finally { db.close(); }
});

it("compares a migrated copy with its baseline across versions and detects changed seats and lost rows while the migrated WAL is open", async () => {
  const root = temporary(), source = join(root, "source"), preview = join(root, "preview");
  mkdirSync(join(source, "state"), { recursive: true });
  const original = new DatabaseSync(join(source, "state", "junto.db"));
  original.exec(`PRAGMA user_version=21;
    CREATE TABLE canvases(canvas_name TEXT PRIMARY KEY, canvas_id TEXT NOT NULL);
    CREATE TABLE seats(canvas_name TEXT NOT NULL, id TEXT NOT NULL, label TEXT, session_id TEXT, PRIMARY KEY(canvas_name, id));
    CREATE TABLE work_messages(id TEXT PRIMARY KEY);
    INSERT INTO canvases VALUES ('factory', 'c');
    INSERT INTO seats VALUES ('factory', 'seat', 'worker', 'session-original');
    INSERT INTO work_messages VALUES ('mail')`);
  original.close();
  await snapshotPreview(source, preview);
  const migrated = new DatabaseSync(join(preview, ".junto", "state", "junto.db"));
  try {
    migrated.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
    // A later step drops a column and adds a table: neither is a change.
    migrated.exec("ALTER TABLE seats DROP COLUMN session_id; CREATE TABLE seat_offboard_clock(seat_id TEXT); PRAGMA user_version=25");
    const good = checkPreview(preview);
    expect(good.failures).toEqual([]);
    expect(good.ok).toBe(true);
    expect(good.identity.find(result => result.table === "seats")?.compared).toEqual(["canvas_name", "id", "label"]);
    expect(good.rowCounts).toContainEqual({ table: "seat_offboard_clock", before: null, after: 0 });
    migrated.exec("UPDATE seats SET label='renamed'; DELETE FROM work_messages");
    const changed = checkPreview(preview);
    expect(changed.ok).toBe(false);
    expect(changed.identity.find(result => result.table === "seats")?.changed).toEqual([{ key: "factory/seat", changes: { label: { before: "worker", after: "renamed" } } }]);
    expect(changed.failures).toContain("work_messages: 1 rows before, 0 after");
    expect(changed.unchangedBaseline).toBe(true);
  } finally { migrated.close(); }
});

it("refuses copy launch even with an inert-looking environment variable and cleans only the explicit copy home", () => {
  const home = temporary();
  const copy = join(home, ".junto-preview-copy"), fresh = join(home, ".junto-preview");
  mkdirSync(copy); mkdirSync(fresh); writeFileSync(join(fresh, "keep"), "keep");
  const result = spawnSync("bash", ["scripts/preview.sh", "--copy"], { env: { ...process.env, HOME: home, JUNTO_PREVIEW_INERT: "1" }, encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("no inert guarantee");
  execFileSync("bash", ["scripts/preview.sh", "--clean"], { env: { ...process.env, HOME: home } });
  expect(existsSync(copy)).toBe(false);
  expect(readFileSync(join(fresh, "keep"), "utf8")).toBe("keep");
  symlinkSync(fresh, copy);
  expect(spawnSync("bash", ["scripts/preview.sh", "--clean"], { env: { ...process.env, HOME: home } }).status).toBe(1);
  expect(existsSync(join(fresh, "keep"))).toBe(true);
});
