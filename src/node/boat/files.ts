/**
 * Boat's files under the Junto home (docs/machines.md, Boat machines). On the
 * editing machine: the record of each Boat machine, Junto's own SSH key and
 * each machine's known-hosts file. On a Boat machine: its sandbox id and its
 * machine key. Every directory is the user's, 0700, never a link; every file
 * is written whole, 0600, to a fresh temp file and renamed into place.
 */
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { BoatEnvironmentName, BoatKeyId, BoatKeySecret, BoatMachine, BoatSandboxId } from "@shared/boat";
import { MachineName } from "@shared/machine-control";

const run = promisify(execFile);

export class BoatFileRefused extends Schema.TaggedError<BoatFileRefused>()("BoatFileRefused", {
  check: Schema.Literals(["not-owned", "not-directory", "not-file", "unreadable"]),
  path: Schema.String,
  message: Schema.String,
}) {}

export const boatDir = (home: string): string => join(home, ".junto", "boat");

const missing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT";
const owned = (path: string, metadata: { uid: number; mode: number }): void => {
  if (metadata.uid !== process.getuid!() || (metadata.mode & 0o077) !== 0) {
    throw new BoatFileRefused({ check: "not-owned", path, message: `Boat files must be this user's alone: ${path}` });
  }
};

/** The directory, made 0700 if missing; refused when it is a link or anyone else's. */
const ownedDir = async (path: string): Promise<string> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new BoatFileRefused({ check: "not-directory", path, message: `Not a real directory: ${path}` });
  owned(path, metadata);
  return path;
};

/** The file's text, or undefined when there is none; a link or a foreign file is refused. */
const readOwned = async (path: string): Promise<string | undefined> => {
  let metadata;
  try { metadata = await lstat(path); } catch (cause) { if (missing(cause)) return undefined; throw cause; }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new BoatFileRefused({ check: "not-file", path, message: `Not a regular file: ${path}` });
  owned(path, metadata);
  return readFile(path, "utf8");
};

/** Written whole, then renamed over the old one: a reader never sees half. */
const writeOwned = async (path: string, body: string): Promise<void> => {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, body, { mode: 0o600, flag: "wx" });
  try { await rename(temp, path); } catch (cause) { await unlink(temp).catch(() => undefined); throw cause; }
};

// --- The editing machine ------------------------------------------------------

export const BoatMachineRecord = Schema.Struct({
  name: MachineName,
  ...BoatMachine.fields,
  environment: Schema.optionalKey(BoatEnvironmentName),
  /** The newest held mail a wake was made for, so one mail wakes a machine once. */
  wokenForMail: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(128)))),
  /** A machine key whose revocation failed: listed until a later revocation succeeds. */
  unrevokedKeyIds: Schema.optionalKey(Schema.Array(BoatKeyId).pipe(Schema.check(Schema.isMaxLength(16)))),
});
export type BoatMachineRecord = typeof BoatMachineRecord.Type;

export const BoatRecords = Schema.Struct({
  version: Schema.Literal(1),
  /** Boat's id for the account key in the secret store. */
  accountKeyId: Schema.optionalKey(BoatKeyId),
  accountKeyExpiresAt: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(64)))),
  /** An account key whose revocation failed. */
  unrevokedKeyIds: Schema.optionalKey(Schema.Array(BoatKeyId).pipe(Schema.check(Schema.isMaxLength(16)))),
  /** The keeper's last tick: a machine asleep since before this was asleep while this one was away. */
  heartbeatAt: Schema.optionalKey(Schema.Number),
  machines: Schema.Array(BoatMachineRecord).pipe(Schema.check(Schema.isMaxLength(32))),
});
export type BoatRecords = typeof BoatRecords.Type;

const EMPTY: BoatRecords = { version: 1, machines: [] };
const recordsPath = (home: string) => join(boatDir(home), "machines.json");

export const readBoatRecords = async (home: string): Promise<BoatRecords> => {
  const path = recordsPath(home);
  const text = await readOwned(path);
  if (text === undefined) return EMPTY;
  try {
    return Schema.decodeUnknownSync(BoatRecords, { onExcessProperty: "error" })(JSON.parse(text));
  } catch {
    throw new BoatFileRefused({ check: "unreadable", path, message: "The Boat machine records could not be read" });
  }
};

/** One writer at a time, in this process; every change reads the newest first. */
let queue: Promise<unknown> = Promise.resolve();
export const updateBoatRecords = (home: string, change: (records: BoatRecords) => BoatRecords): Promise<BoatRecords> => {
  const next = queue.then(async () => {
    await ownedDir(boatDir(home));
    const changed = Schema.decodeUnknownSync(BoatRecords, { onExcessProperty: "error" })(change(await readBoatRecords(home)));
    await writeOwned(recordsPath(home), `${JSON.stringify(changed, null, 2)}\n`);
    return changed;
  });
  queue = next.catch(() => undefined);
  return next;
};

/** Junto's own SSH key for Boat machines, made once; the public half is returned. */
export const ensureBoatSshKey = async (home: string): Promise<{ readonly identityFile: string; readonly publicKey: string }> => {
  const dir = await ownedDir(boatDir(home));
  const identityFile = join(dir, "id_ed25519");
  if (await readOwned(identityFile) === undefined) {
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "junto-boat", "-f", identityFile], { timeout: 30_000 });
    // ssh-keygen leaves the public half 0644; both halves are this user's alone.
    await chmod(`${identityFile}.pub`, 0o600);
  }
  await readOwned(identityFile);
  const publicKey = (await readOwned(`${identityFile}.pub`))?.trim();
  if (publicKey === undefined || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( junto-boat)?$/.test(publicKey)) {
    throw new BoatFileRefused({ check: "unreadable", path: `${identityFile}.pub`, message: "Junto's Boat SSH key could not be read" });
  }
  return { identityFile, publicKey };
};

/** The alias a machine's host key is filed under; it never names an address. */
export const boatHostKeyAlias = (sandboxId: string): string => `junto-boat.${sandboxId.replace(/_/g, "-")}`;

/**
 * Rewrites the machine's own known-hosts file with exactly the one key Boat
 * answered. Answers the old key when it changed.
 */
export const writeBoatKnownHost = async (home: string, sandboxId: string, hostKey: string): Promise<{ readonly path: string; readonly previous?: string }> => {
  const dir = await ownedDir(join(boatDir(home), "known_hosts"));
  const path = join(dir, Schema.decodeUnknownSync(BoatSandboxId)(sandboxId));
  const line = `${boatHostKeyAlias(sandboxId)} ${hostKey}\n`;
  const before = await readOwned(path);
  if (before === line) return { path };
  await writeOwned(path, line);
  const previous = before?.trim().split(" ").slice(1).join(" ");
  return { path, ...(previous ? { previous } : {}) };
};

// --- On a Boat machine --------------------------------------------------------

const MachineSelf = Schema.Struct({ version: Schema.Literal(1), sandboxId: BoatSandboxId, keyId: BoatKeyId });
export type BoatMachineSelf = typeof MachineSelf.Type;

/** The machine key, as Boat's API takes it. */
export { BoatKeySecret } from "@shared/boat";

/** Written by `junto machine boat-key-local` from its stdin, nowhere else. */
export const writeBoatMachineSelf = async (home: string, self: BoatMachineSelf, key: string): Promise<void> => {
  const dir = await ownedDir(boatDir(home));
  await writeOwned(join(dir, "machine-key"), `${Schema.decodeUnknownSync(BoatKeySecret)(key)}\n`);
  await writeOwned(join(dir, "machine.json"), `${JSON.stringify(Schema.decodeUnknownSync(MachineSelf)(self))}\n`);
};

/** This machine's sandbox and key, when it is a Boat machine. */
export const readBoatMachineSelf = async (home: string): Promise<{ readonly self: BoatMachineSelf; readonly key: string } | undefined> => {
  const dir = boatDir(home);
  const text = await readOwned(join(dir, "machine.json"));
  const key = (await readOwned(join(dir, "machine-key")))?.trim();
  if (text === undefined || key === undefined) return undefined;
  try {
    return {
      self: Schema.decodeUnknownSync(MachineSelf, { onExcessProperty: "error" })(JSON.parse(text)),
      key: Schema.decodeUnknownSync(BoatKeySecret)(key),
    };
  } catch {
    throw new BoatFileRefused({ check: "unreadable", path: dir, message: "This machine's Boat key could not be read" });
  }
};
