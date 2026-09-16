import { createHash } from "node:crypto";
import { join } from "node:path";

/** macOS AF_UNIX path cap. OpenSSH refuses the bind above this. */
export const UNIX_DOMAIN_SOCKET_PATH_LIMIT = 104;

/**
 * OpenSSH binds `ControlPath` plus a temporary suffix (mkstemp
 * `.XXXXXXXXXX`, sometimes a longer random token). Keep 20 bytes of headroom.
 */
export const OPENSSH_CONTROL_PATH_TEMP_SUFFIX = 20;

/** OpenSSH `%C` expands to a 40-character SHA1 hex of the connection. */
export const OPENSSH_CONTROL_HASH_TOKEN = "%C";

const EXPANDED_CONTROL_HASH = "a".repeat(40);
const MUX_DIR_PATTERN = /^\/tmp\/vc-\d+-[0-9a-f]{8}$/u;

/** Short per-user, per-home mux directory. Never `$TMPDIR` — those paths are long. */
export const sshMuxControlDir = (
  juntoHome: string,
  uid = process.getuid?.() ?? 0,
): string => {
  const normalized = juntoHome.replace(/\/+$/u, "") || "/";
  const tag = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  const dir = `/tmp/vc-${uid}-${tag}`;
  if (!MUX_DIR_PATTERN.test(dir)) {
    throw new TypeError("SSH mux control directory is outside the short /tmp contract");
  }
  return dir;
};

export const sshMuxControlPathTemplate = (controlDir: string): string =>
  join(controlDir, OPENSSH_CONTROL_HASH_TOKEN);

export const expandedMuxControlPathBytes = (controlDir: string): number =>
  Buffer.byteLength(join(controlDir, EXPANDED_CONTROL_HASH), "utf8");

export const muxControlPathFitsUnixLimit = (controlDir: string): boolean =>
  expandedMuxControlPathBytes(controlDir) + OPENSSH_CONTROL_PATH_TEMP_SUFFIX <=
  UNIX_DOMAIN_SOCKET_PATH_LIMIT;

export const assertMuxControlDirBudget = (controlDir: string): void => {
  if (!muxControlPathFitsUnixLimit(controlDir)) {
    throw new TypeError(
      "SSH mux ControlPath exceeds the Unix domain socket path limit",
    );
  }
};
