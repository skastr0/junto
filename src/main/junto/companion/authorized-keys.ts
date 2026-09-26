/**
 * ~/.ssh/authorized_keys, edited for paired phones only.
 *
 * Junto owns exactly the lines whose comment is `junto-companion:dev_<ulid>`
 * and nothing else: every other line (the operator's own keys, comments,
 * blank lines, odd whitespace, a missing final newline) survives byte for
 * byte. Each phone line pins its key to `junto companion-stdio --device <id>`
 * with `restrict`, so the key can do nothing but speak the companion protocol.
 *
 * Writes are atomic: a temporary file in the same directory, 0600, fsynced,
 * renamed over the original. A symlinked authorized_keys is refused rather
 * than replaced, and a file that changed underneath the edit is re-read and
 * the edit re-applied.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const COMPANION_KEY_TAG = "junto-companion:";

const DEVICE_ID = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/u;
const PUBLIC_KEY = /^(?:ecdsa-sha2-nistp256|ssh-ed25519) [A-Za-z0-9+/]{16,}={0,3}$/u;
/** A path the forced command can quote with single quotes, and sshd can carry in double quotes. */
const SAFE_PATH = /^\/[^'"\\\n\r\u0000]*$/u;

export const defaultAuthorizedKeysPath = (): string => join(homedir(), ".ssh", "authorized_keys");

export class AuthorizedKeysError extends Error {
  readonly reason: "invalid" | "symlink" | "io";
  constructor(reason: "invalid" | "symlink" | "io", message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The one line Junto writes for a phone. */
export const companionKeyLine = (input: {
  readonly juntoPath: string;
  readonly deviceId: string;
  readonly publicKey: string;
}): string => {
  if (!DEVICE_ID.test(input.deviceId)) throw new AuthorizedKeysError("invalid", "device id is not valid");
  if (!PUBLIC_KEY.test(input.publicKey)) throw new AuthorizedKeysError("invalid", "public key is not valid");
  if (!SAFE_PATH.test(input.juntoPath)) throw new AuthorizedKeysError("invalid", "junto path cannot be quoted safely");
  const command = `'${input.juntoPath}' companion-stdio --device ${input.deviceId}`;
  return `command="${command}",restrict ${input.publicKey} ${COMPANION_KEY_TAG}${input.deviceId}`;
};

/** The device a line belongs to, when (and only when) Junto wrote it. */
export const companionDeviceOfLine = (line: string): string | undefined => {
  const match = /\sjunto-companion:(dev_[0-9A-HJKMNP-TV-Z]{26})\r?$/u.exec(line);
  return match?.[1];
};

type Lines = { readonly lines: string[]; readonly trailingNewline: boolean };

const split = (text: string): Lines => {
  if (text === "") return { lines: [], trailingNewline: true };
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), trailingNewline };
};

const join_ = ({ lines, trailingNewline }: Lines): string =>
  lines.length === 0 ? "" : `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;

/** Every device with a Junto line in this file, in file order. */
export const companionDevicesIn = (text: string): ReadonlyArray<string> =>
  split(text).lines.flatMap((line) => {
    const device = companionDeviceOfLine(line);
    return device === undefined ? [] : [device];
  });

/**
 * Put `line` in place of the device's existing line(s), or append it. A second
 * stale line for the same device is removed. Everything else is untouched.
 */
export const upsertCompanionKey = (text: string, deviceId: string, line: string): string => {
  if (companionDeviceOfLine(line) !== deviceId) {
    throw new AuthorizedKeysError("invalid", "line does not belong to this device");
  }
  const parsed = split(text);
  let placed = false;
  const lines: string[] = [];
  for (const existing of parsed.lines) {
    if (companionDeviceOfLine(existing) !== deviceId) {
      lines.push(existing);
    } else if (!placed) {
      lines.push(line);
      placed = true;
    }
  }
  if (!placed) {
    lines.push(line);
    // Appending after a file without a final newline must not glue two keys.
    return join_({ lines, trailingNewline: true });
  }
  return join_({ lines, trailingNewline: parsed.trailingNewline });
};

/** Remove the device's line(s). Everything else is untouched. */
export const removeCompanionKey = (text: string, deviceId: string): string => {
  const parsed = split(text);
  const lines = parsed.lines.filter((line) => companionDeviceOfLine(line) !== deviceId);
  if (lines.length === parsed.lines.length) return text;
  return join_({ lines, trailingNewline: parsed.trailingNewline });
};

/** Remove every Junto line whose device is not in `keep`. */
export const pruneCompanionKeys = (text: string, keep: ReadonlySet<string>): string => {
  const parsed = split(text);
  const lines = parsed.lines.filter((line) => {
    const device = companionDeviceOfLine(line);
    return device === undefined || keep.has(device);
  });
  if (lines.length === parsed.lines.length) return text;
  return join_({ lines, trailingNewline: parsed.trailingNewline });
};

// --- the file ------------------------------------------------------------------

const readIfPresent = (path: string): string => {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new AuthorizedKeysError("symlink", "authorized_keys is a symbolic link; Junto will not replace it");
    }
    if (!stat.isFile()) throw new AuthorizedKeysError("io", "authorized_keys is not a regular file");
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
};

const ensureSshDirectory = (path: string): void => {
  const dir = dirname(path);
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) throw new AuthorizedKeysError("io", `${dir} is not a directory`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
};

const writeAtomic = (path: string, text: string): void => {
  const temp = join(dirname(path), `.authorized_keys.junto-${randomBytes(6).toString("hex")}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    const bytes = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
};

let chain: Promise<unknown> = Promise.resolve();

/**
 * Apply `edit` to the file atomically. Edits in this process run one at a
 * time; an edit that finds the file changed between read and rename (another
 * program writing it) is re-applied to the new contents, up to three times.
 * Returns the text now on disk.
 */
export const editAuthorizedKeys = (
  edit: (text: string) => string,
  path: string = defaultAuthorizedKeysPath(),
): Promise<string> => {
  const run = async (): Promise<string> => {
    ensureSshDirectory(path);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = readIfPresent(path);
      const after = edit(before);
      if (after === before) return before;
      if (readIfPresent(path) !== before) continue;
      writeAtomic(path, after);
      return after;
    }
    throw new AuthorizedKeysError("io", "authorized_keys kept changing while Junto edited it");
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
};

/** Read the file (empty when absent); refuses a symlink like the writer does. */
export const readAuthorizedKeys = (path: string = defaultAuthorizedKeysPath()): string => readIfPresent(path);
