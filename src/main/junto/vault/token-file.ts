/**
 * This machine's vault token (docs/machines.md, The vault): one 1Password
 * service-account token in `<home>/.junto/core/vault/op-token`, as the Boat
 * machine key is kept. The directory is the user's, 0700, never a link; the
 * file is written whole, 0600, to a fresh temp file and renamed into place.
 * Its scope record is a row (`./repository.ts`); the token is never one.
 */
import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { VaultTokenSecret } from "@shared/vault";
import { registerKnownSecrets } from "../credentials/scrub";

export class VaultTokenFileRefused extends Schema.TaggedError<VaultTokenFileRefused>()("VaultTokenFileRefused", {
  check: Schema.Literals(["not-owned", "not-directory", "not-file", "unreadable"]),
  message: Schema.String,
}) {}

export const vaultDir = (home: string): string => join(home, ".junto", "core", "vault");
const tokenPath = (home: string): string => join(vaultDir(home), "op-token");

/** The scrub's owner for this machine's token. */
const SCRUB_OWNER = "vault-token";

const missing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT";
const owned = (metadata: { uid: number; mode: number }): void => {
  if (metadata.uid !== process.getuid!() || (metadata.mode & 0o077) !== 0) {
    throw new VaultTokenFileRefused({ check: "not-owned", message: "The vault token's files must be this user's alone" });
  }
};

const ownedDir = async (home: string): Promise<string> => {
  const path = vaultDir(home);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new VaultTokenFileRefused({ check: "not-directory", message: "The vault directory is not a real directory" });
  owned(metadata);
  return path;
};

/**
 * Written by `junto machine vault-token-local` from its stdin, nowhere else.
 * A value that is not a token's shape is refused without being repeated.
 */
export const writeVaultToken = async (home: string, token: string): Promise<void> => {
  const decoded = Schema.decodeUnknownResult(VaultTokenSecret)(token);
  if (decoded._tag === "Failure") throw new VaultTokenFileRefused({ check: "unreadable", message: "That is not a 1Password service account token" });
  const dir = await ownedDir(home);
  const path = join(dir, "op-token");
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${decoded.success}\n`, { mode: 0o600, flag: "wx" });
  try { await rename(temp, path); } catch (cause) { await unlink(temp).catch(() => undefined); throw cause; }
  registerKnownSecrets(SCRUB_OWNER, [decoded.success]);
};

/** This machine's token, or none; a link, a foreign file or a bad shape is refused. Read, it is a known value for the scrub. */
export const readVaultToken = async (home: string): Promise<string | undefined> => {
  const path = tokenPath(home);
  let metadata;
  try { metadata = await lstat(path); } catch (cause) { if (missing(cause)) return undefined; throw cause; }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new VaultTokenFileRefused({ check: "not-file", message: "The vault token is not a regular file" });
  owned(metadata);
  const decoded = Schema.decodeUnknownResult(VaultTokenSecret)((await readFile(path, "utf8")).trim());
  if (decoded._tag === "Failure") throw new VaultTokenFileRefused({ check: "unreadable", message: "This machine's vault token could not be read" });
  registerKnownSecrets(SCRUB_OWNER, [decoded.success]);
  return decoded.success;
};

/** The token comes off this machine; its scrub entry stays until the process ends, in case a log still holds it. */
export const removeVaultToken = async (home: string): Promise<void> => {
  await rm(tokenPath(home), { force: true });
};
