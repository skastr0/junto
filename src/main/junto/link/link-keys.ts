/**
 * Links bound to their opener's key (docs/machines.md, The link;
 * docs/security-doctrine.md, Links).
 *
 * On the machine that dials: one ed25519 key per peer, the route resolved for
 * it at setup and a known-hosts file holding only the host key the setup
 * session verified, under `<home>/.junto/core/link-keys/<peer>/`. The private
 * key is written once, 0600, and only ssh reads it again.
 *
 * On the machine that receives: one authorized_keys line per opener, which
 * lets that key run `junto link --opener <id>` and nothing else. Junto owns
 * only lines tagged `junto-link:<home>:<id>`; every other byte survives, as
 * with the companion's lines (companion/authorized-keys.ts).
 *
 * Every line is built from typed fields only: a quote, a newline, an option
 * prefix or a second key in any of them would open an unrestricted line.
 */
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { InstallationId } from "@shared/installation-id";
import { isValidMachineName } from "@shared/machine-identity";
import { AuthorizedKeysError } from "../companion/authorized-keys";
import { encodeOpenSshEd25519 } from "../companion/pairing-key";

export const LINK_KEY_TAG = "junto-link:";

/** `ssh-ed25519` and its base64 blob, nothing else: the shape companion/authorized-keys.ts:35 admits, ed25519 only. */
const ED25519_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{16,}={0,3}$/u;
/** A path the forced command can quote with single quotes, and sshd can carry in double quotes. */
const SAFE_PATH = /^\/[^'"\\\n\r\u0000]*$/u;
/** One literal host: a DNS name or an IPv4 address, never a pattern, a list or a marker. */
const LITERAL_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/u;
const LITERAL_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/u;
const HOME_TAG = /^[0-9a-f]{12}$/u;

export class LinkKeyRefused extends Schema.TaggedError<LinkKeyRefused>()("LinkKeyRefused", {
  check: Schema.Literals(["invalid", "exists", "missing", "no-host-key", "revoked-host-key", "route"]),
  message: Schema.String,
}) {}

const decodeId = Schema.decodeUnknownSync(InstallationId);
const installationId = (value: string): InstallationId => {
  try { return decodeId(value); }
  catch { throw new LinkKeyRefused({ check: "invalid", message: "an installation id is letters, digits, dots, colons, dashes and underscores" }); }
};
const machine = (value: string): string => {
  if (!isValidMachineName(value)) throw new LinkKeyRefused({ check: "invalid", message: "a machine name is a short literal name" });
  return value;
};

/** An ed25519 public key, checked down to its blob: the type string, then 32 key bytes, and nothing after. */
export const isLinkPublicKey = (key: string): boolean => {
  if (!ED25519_KEY.test(key)) return false;
  const blob = Buffer.from(key.slice("ssh-ed25519 ".length), "base64");
  if (blob.byteLength !== 51 || blob.readUInt32BE(0) !== 11 || blob.subarray(4, 15).toString("latin1") !== "ssh-ed25519") return false;
  return blob.readUInt32BE(15) === 32;
};
const publicKey = (key: string): string => {
  if (!isLinkPublicKey(key)) throw new LinkKeyRefused({ check: "invalid", message: "a link key is one ssh-ed25519 public key" });
  return key;
};

// --- the machine that dials ------------------------------------------------------

export const linkKeyDirectory = (home: string, peer: string): string => join(home, ".junto", "core", "link-keys", machine(peer));

export interface BoundRoute {
  readonly user: string;
  readonly host: string;
  readonly port: number;
}

export interface BoundRouteFiles extends BoundRoute {
  readonly identityFile: string;
  readonly knownHostsFile: string;
}

const writeNew = (path: string, text: string, mode: number): void => {
  const fd = openSync(path, "wx", mode);
  try {
    const bytes = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset);
  } finally { closeSync(fd); }
};

/** Replaces a small file atomically: a sibling written 0600, then renamed over it. */
const replace = (path: string, text: string): void => {
  const temp = `${path}.junto-new`;
  rmSync(temp, { force: true });
  writeNew(temp, text, 0o600);
  renameSync(temp, path);
};

/**
 * A new key for links to `peer`, made in-process (no ssh-keygen, so no argv
 * at all) and written with exclusive create: an existing key is refused, and
 * `replace` removes it first. Answers the public half only.
 */
export const makeLinkKey = (home: string, peer: string, self: string, options: { readonly replace?: boolean } = {}): string => {
  const comment = `${LINK_KEY_TAG}${installationId(self)}`;
  const directory = linkKeyDirectory(home, peer);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identityFile = join(directory, "id_ed25519");
  if (options.replace === true) {
    rmSync(identityFile, { force: true });
    rmSync(`${identityFile}.pub`, { force: true });
  } else if (existsSync(identityFile) || existsSync(`${identityFile}.pub`)) {
    throw new LinkKeyRefused({ check: "exists", message: `A link key for ${peer} already exists` });
  }
  const pair = generateKeyPairSync("ed25519");
  const pub = pair.publicKey.export({ format: "jwk" }).x;
  const seed = pair.privateKey.export({ format: "jwk" }).d;
  if (typeof pub !== "string" || typeof seed !== "string") throw new LinkKeyRefused({ check: "invalid", message: "the ed25519 key could not be made" });
  const encoded = encodeOpenSshEd25519(Buffer.from(seed, "base64url"), Buffer.from(pub, "base64url"), { comment });
  try {
    writeNew(identityFile, encoded.privateKey, 0o600);
    writeNew(`${identityFile}.pub`, `${encoded.publicKey} ${comment}\n`, 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new LinkKeyRefused({ check: "exists", message: `A link key for ${peer} already exists` });
    throw cause;
  }
  return publicKey(encoded.publicKey);
};

/** The known-hosts name OpenSSH looks a literal host up under. */
const knownHostsName = (host: string, port: number): string => port === 22 ? host : `[${host}]:${port}`;

const boundRoute = (route: BoundRoute): BoundRoute => {
  if (!LITERAL_USER.test(route.user) || !LITERAL_HOST.test(route.host) || !Number.isInteger(route.port) || route.port < 1 || route.port > 65_535) {
    throw new LinkKeyRefused({ check: "route", message: "a bound route is one literal user, host and port" });
  }
  return { user: route.user, host: route.host, port: route.port };
};

/**
 * The host keys a link to `peer` accepts, written here by this machine: one
 * literal host per line, no markers. Answers the file, which also pins the
 * setup sessions to exactly these keys.
 */
export const writeLinkKnownHosts = (home: string, peer: string, route: BoundRoute, hostKeys: ReadonlyArray<string>): string => {
  const checked = boundRoute(route);
  if (hostKeys.length === 0 || hostKeys.length > 8) throw new LinkKeyRefused({ check: "no-host-key", message: `No host key to accept for ${peer}` });
  const keys = hostKeys.map(publicKey);
  const directory = linkKeyDirectory(home, peer);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const knownHostsFile = join(directory, "known_hosts");
  const name = knownHostsName(checked.host, checked.port);
  replace(knownHostsFile, keys.map((key) => `${name} ${key}\n`).join(""));
  return knownHostsFile;
};

/**
 * Records the route a link to `peer` dials, once its key and known hosts are
 * in place. From then on a link to `peer` dials with them only.
 */
export const writeBoundRoute = (home: string, peer: string, route: BoundRoute): BoundRouteFiles => {
  const checked = boundRoute(route);
  const directory = linkKeyDirectory(home, peer);
  const identityFile = join(directory, "id_ed25519");
  const knownHostsFile = join(directory, "known_hosts");
  if (!existsSync(identityFile)) throw new LinkKeyRefused({ check: "missing", message: `There is no link key for ${peer}` });
  if (!existsSync(knownHostsFile)) throw new LinkKeyRefused({ check: "no-host-key", message: `No host key is recorded for ${peer}` });
  replace(join(directory, "route.json"), `${JSON.stringify(checked)}\n`);
  return { ...checked, identityFile, knownHostsFile };
};

/** The bound route recorded for `peer`, or none: a link to it then dials over the operator's route. */
export const readBoundRoute = (home: string, peer: string): BoundRouteFiles | undefined => {
  if (!isValidMachineName(peer)) return undefined;
  const directory = linkKeyDirectory(home, peer);
  const identityFile = join(directory, "id_ed25519");
  const knownHostsFile = join(directory, "known_hosts");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(directory, "route.json"), "utf8")); }
  catch { return undefined; }
  if (!existsSync(identityFile) || !existsSync(knownHostsFile)) return undefined;
  const fields = raw as Partial<BoundRoute>;
  try {
    return { ...boundRoute({ user: String(fields.user), host: String(fields.host), port: Number(fields.port) }), identityFile, knownHostsFile };
  } catch { return undefined; }
};

/** Forgets every key and route for links to `peer`. */
export const removeLinkKey = (home: string, peer: string): void => {
  rmSync(linkKeyDirectory(home, peer), { recursive: true, force: true });
};

// --- host keys the setup session verified ------------------------------------------

const hashedMatches = (pattern: string, name: string): boolean => {
  const parts = /^\|1\|([A-Za-z0-9+/=]+)\|([A-Za-z0-9+/=]+)$/u.exec(pattern);
  if (parts === null) return false;
  return createHmac("sha1", Buffer.from(parts[1]!, "base64")).update(name).digest("base64") === parts[2];
};

/**
 * The ed25519 host keys these known-hosts files hold for exactly `host` at
 * `port`, as `ssh-keygen -F` finds them: plain or hashed names, comma lists.
 * A wildcard or negated pattern never counts, a revoked key refuses, and a
 * certificate authority is not a host key.
 */
export const verifiedHostKeys = (files: ReadonlyArray<string>, host: string, port: number): ReadonlyArray<string> => {
  const name = knownHostsName(boundRoute({ user: "x", host, port }).host, port);
  const found = new Set<string>();
  const revoked = new Set<string>();
  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      const fields = line.split(/\s+/u);
      const marker = fields[0]!.startsWith("@") ? fields.shift() : undefined;
      if (marker !== undefined && marker !== "@revoked") continue;
      const [patterns, type, blob] = fields;
      if (patterns === undefined || type === undefined || blob === undefined) continue;
      const matches = patterns.split(",").some((pattern) => pattern === name || hashedMatches(pattern, name));
      if (!matches) continue;
      const key = `${type} ${blob}`;
      if (marker === "@revoked") { revoked.add(key); continue; }
      if (isLinkPublicKey(key)) found.add(key);
    }
  }
  for (const key of found) if (revoked.has(key)) throw new LinkKeyRefused({ check: "revoked-host-key", message: `The host key known for ${host} is revoked` });
  if (found.size === 0) throw new LinkKeyRefused({ check: "no-host-key", message: `No ed25519 host key is known for ${host}; connect to it once with ssh to verify it` });
  return [...found];
};

// --- the machine that receives -------------------------------------------------------

/** Which Junto home a line belongs to: several homes on one account share its authorized_keys. */
export const linkHomeTag = (juntoHome: string): string => createHash("sha256").update(resolve(juntoHome)).digest("hex").slice(0, 12);

/** The one line Junto writes for an opener: that key may only relay to this home's core, as that opener. */
export const linkKeyLine = (input: {
  readonly juntoHome: string;
  readonly juntoPath: string;
  readonly opener: string;
  readonly publicKey: string;
}): string => {
  const opener = installationId(input.opener);
  const key = publicKey(input.publicKey);
  if (!SAFE_PATH.test(input.juntoHome) || !SAFE_PATH.test(input.juntoPath)) throw new LinkKeyRefused({ check: "invalid", message: "the junto path cannot be quoted safely" });
  const command = `/usr/bin/env JUNTO_HOME='${resolve(input.juntoHome)}' '${input.juntoPath}' link --opener ${opener}`;
  return `command="${command}",restrict ${key} ${LINK_KEY_TAG}${linkHomeTag(input.juntoHome)}:${opener}`;
};

/** The home and opener a line belongs to, when (and only when) Junto wrote it. */
export const linkLineOwner = (line: string): { readonly home: string; readonly opener: string } | undefined => {
  const match = /\sjunto-link:([0-9a-f]{12}):([A-Za-z0-9][A-Za-z0-9._:-]*)\r?$/u.exec(line);
  return match === null ? undefined : { home: match[1]!, opener: match[2]! };
};

type Lines = { readonly lines: string[]; readonly trailingNewline: boolean };
const split = (text: string): Lines => {
  if (text === "") return { lines: [], trailingNewline: true };
  const trailingNewline = text.endsWith("\n");
  return { lines: (trailingNewline ? text.slice(0, -1) : text).split("\n"), trailingNewline };
};
const joined = ({ lines, trailingNewline }: Lines): string => lines.length === 0 ? "" : `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;

/** Puts `line` in place of that opener's line for that home, or appends it. Everything else is untouched. */
export const upsertLinkLine = (text: string, line: string): string => {
  const owner = linkLineOwner(line);
  if (owner === undefined || !HOME_TAG.test(owner.home)) throw new AuthorizedKeysError("invalid", "line is not a Junto link line");
  const parsed = split(text);
  let placed = false;
  const lines: string[] = [];
  for (const existing of parsed.lines) {
    const held = linkLineOwner(existing);
    if (held === undefined || held.home !== owner.home || held.opener !== owner.opener) lines.push(existing);
    else if (!placed) { lines.push(line); placed = true; }
  }
  if (!placed) { lines.push(line); return joined({ lines, trailingNewline: true }); }
  return joined({ lines, trailingNewline: parsed.trailingNewline });
};

/** Removes that home's lines: one opener's, or every one when no opener is named. */
export const removeLinkLines = (text: string, home: string, opener?: string): string => {
  const parsed = split(text);
  const lines = parsed.lines.filter((line) => {
    const held = linkLineOwner(line);
    return held === undefined || held.home !== home || (opener !== undefined && held.opener !== opener);
  });
  return lines.length === parsed.lines.length ? text : joined({ lines, trailingNewline: parsed.trailingNewline });
};

/** Is that opener's line present for that home. */
export const hasLinkLine = (text: string, home: string, opener: string): boolean =>
  split(text).lines.some((line) => {
    const held = linkLineOwner(line);
    return held !== undefined && held.home === home && held.opener === opener;
  });

