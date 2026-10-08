import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { snapshotPreview } from "../scripts/preview-snapshot";
import { checkPreview } from "../scripts/preview-db-check";
import { migrateCanvasKinds } from "../src/main/junto/model/migrate";
import { CANVAS_AUTHORITY_SCHEMA_SQL } from "./fixtures/state-v1/canvas-schema";
import { ENTITIES_STATE_SCHEMA_SQL } from "./fixtures/domain-cutover/entities-schema";

const paths: string[] = [];
const temporary = () => { const p = mkdtempSync(join(tmpdir(), "junto-preview-test-")); paths.push(p); return p; };
afterEach(() => { for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true }); });

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

it("reports preservation, fallback reasons and detects a changed session while the migrated WAL is open", async () => {
  const root = temporary(), source = join(root, "source"), preview = join(root, "preview");
  mkdirSync(join(source, "state"), { recursive: true });
  const original = new DatabaseSync(join(source, "state", "junto.db"));
  original.exec(CANVAS_AUTHORITY_SCHEMA_SQL + ENTITIES_STATE_SCHEMA_SQL + "PRAGMA user_version=11; CREATE TABLE work_messages(id TEXT PRIMARY KEY); INSERT INTO work_messages VALUES ('mail')");
  original.prepare("INSERT INTO canvas_documents VALUES(?,?,?,?,?)").run("c", "factory", "a".repeat(64), "now", "now");
  const insert = original.prepare("INSERT INTO canvas_nodes(canvas_id,node_id,z_index,type,x,y,width,height,text_content,ether_json,updated_at) VALUES('c',?,?, 'text',0,0,220,90,'card',?,'now')");
  insert.run("seat", 0, JSON.stringify({ entity: { kind: "agent", name: "local:worker" }, terminal: { bindingId: "binding", harness: "codex", sessionId: "session-original" } }));
  insert.run("retired", 1, JSON.stringify({ entity: { kind: "retired-kind", name: "retired" } }));
  original.close();
  await snapshotPreview(source, preview);
  const migrated = new DatabaseSync(join(preview, ".junto", "state", "junto.db"));
  try {
    migrated.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
    migrateCanvasKinds(migrated);
    migrated.exec("PRAGMA user_version=13");
    const good = checkPreview(preview);
    expect(good.ok).toBe(true);
    expect(good.downgraded).toEqual([expect.objectContaining({ id: "retired", reason: expect.stringContaining("preserved as a note") })]);
    expect(good.seatChanges).toEqual([]);
    migrated.exec("UPDATE seats SET session_id='changed-session'");
    const changed = checkPreview(preview);
    expect(changed.ok).toBe(false);
    expect(changed.seatChanges[0]?.changes.sessionId).toEqual({ before: "session-original", after: "changed-session" });
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
