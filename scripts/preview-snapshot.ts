import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const fileSha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const sqliteFile = (path: string): boolean => {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    return readSync(fd, header, 0, 16, 0) === 16 && header.toString() === "SQLite format 3\0";
  } finally { closeSync(fd); }
};

/** Never opens a production database writable, and never copies a live DB/WAL pair. */
export const snapshotPreview = async (source: string, destination: string) => {
  source = resolve(source);
  destination = resolve(destination);
  if (destination === source || destination.startsWith(source + "/") || source.startsWith(destination + "/")) throw new Error("Preview and source must be separate directories");
  if (existsSync(destination)) throw new Error(`Refusing to overwrite existing preview: ${destination}`);
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw new Error("Source must be a real directory");
  mkdirSync(destination, { mode: 0o700 });
  const copied: string[] = [], omitted: Array<{ path: string; reason: string }> = [];
  const copyDatabase = async (from: string, to: string) => {
    const db = new DatabaseSync(from, { readOnly: true, timeout: 1000 });
    try { await backup(db, to); } finally { db.close(); }
    chmodSync(to, 0o600);
  };
  // The baseline is the first read, and remains separate from the writable copy.
  const before = join(destination, "before", "junto.db");
  mkdirSync(dirname(before), { recursive: true, mode: 0o700 });
  await copyDatabase(join(source, "state", "junto.db"), before);
  chmodSync(before, 0o400);
  const working = join(destination, ".junto");
  const walk = async (relative: string): Promise<void> => {
    const from = join(source, relative), to = join(working, relative);
    const stat = lstatSync(from), name = basename(from);
    const omission = stat.isSymbolicLink() ? "symlink: never follow a reference into live state"
      : !stat.isFile() && !stat.isDirectory() ? "live socket or special file"
      : relative === "locks" || name === "SingletonLock" || name === "SingletonCookie" || name === "SingletonSocket" || name === "LOCK" ? "live process lock"
      : name.endsWith(".lease") || name === "token" || name === "control.token" ? "live control credential/lease: preview mints its own"
      : name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith("-journal") ? "SQLite sidecar: included by database backup API"
      : undefined;
    if (omission) { omitted.push({ path: relative, reason: omission }); return; }
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true, mode: 0o700 });
      for (const child of readdirSync(from).sort()) await walk(join(relative, child));
    } else {
      if (relative === "state/junto.db") copyFileSync(before, to);
      else if (sqliteFile(from)) await copyDatabase(from, to);
      else copyFileSync(from, to);
      chmodSync(to, 0o600);
      copied.push(relative);
    }
  };
  await walk("");
  const manifest = { source, destination, directoryMode: "0700", createdAt: new Date().toISOString(), beforeSha256: fileSha256(before), sourceEntries: readdirSync(source).sort(), copied, omitted,
    credentials: "Copies persistent state/credentials, state/region-secrets and license backups with owner-only permissions. Omits live socket tokens/leases. Does not copy macOS Keychain or external ~/.claude, ~/.codex, ~/.hermes stores. Browser profiles are copied; no browser is started. Ordinary mutable files are copied after the coherent product DB snapshot; this is not a cross-filesystem transaction." };
  writeFileSync(join(destination, "snapshot.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return manifest;
};

if (process.argv[1]?.endsWith("/preview-snapshot.ts") || process.argv[1]?.endsWith("/preview-snapshot.mjs") || process.argv[1]?.endsWith("/preview-snapshot.js")) {
  const receipt = await snapshotPreview(join(homedir(), ".junto"), join(homedir(), ".junto-preview-copy"));
  console.log(JSON.stringify({ ...receipt, copied: `${receipt.copied.length} files` }, null, 2));
}
