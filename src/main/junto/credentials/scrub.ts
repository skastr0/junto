/**
 * The one scrub for text that enters a failure, a link frame or a log row
 * (docs/security-doctrine.md, Failures and logs). Steps 2 to 4 run over every
 * message; a stderr tail runs all five steps on the machine that read the
 * bytes.
 */

import { REDACTED, redactSecretValues } from "./redact";

const CUT = " [cut]";
export const SCRUBBED_MESSAGE_LIMIT = 1024;
const TAIL_WINDOW_BYTES = 64 * 1024;
const TAIL_LINES = 40;
const TAIL_BYTES = 4 * 1024;
/** Shorter environment values ("1", "true") would redact ordinary words. */
const ENVIRONMENT_VALUE_FLOOR = 6;
/** Names whose values may show (doctrine 9cba54247 step 3); a closed list, never a prefix but LC_. */
const SHOWN_ENVIRONMENT = new Set([
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "PWD", "TERM", "COLORTERM", "LANG", "JUNTO_HOME",
  "JUNTO_SEAT", "JUNTO_NODE_REF", "JUNTO_SOCKET", "JUNTO_WORK_SOCKET", "JUNTO_WORK_HOME", "JUNTO_CLI",
]);
const shownName = (name: string): boolean => SHOWN_ENVIRONMENT.has(name) || name.startsWith("LC_");

// Step 2: escape sequences whole, then the controls and bidi formatting left.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b[PX^_][\s\S]*?(?:\u001b\\|$)|\u001b[\s\S]?|\u009b[0-?]*[ -/]*[@-~]/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

// Step 4: credential shapes Junto does not know.
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const AUTHORIZATION = /(authorization\s*:\s*)[^\n]*/gi;
const BEARER = /(\bbearer\s+)[^\s"',;]+/gi;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
// The name is bounded: an unbounded prefix rescans from every start (quadratic).
const NAMED_VALUE = /([A-Za-z0-9_.-]{0,48}(?:token|secret|password|passwd|key|credential|auth|cookie|session)[A-Za-z0-9_.-]{0,48}(?:"|')?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s&#"',;]+)/gi;
const TOKEN_SHAPES = /\b(?:sk-|ghp_|gho_|github_pat_|xox[abpr]-|ops_)[A-Za-z0-9_-]+|\bAKIA[A-Z0-9]{12,}|\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const LONG_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
// A UUID (a credential id) is redacted whatever its digits: the mixed-run rule misses one with no letters.
const UUID = /(?<![0-9A-Za-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z])/gi;
/** Junto's own ids, <kind>-<ULID>, are not secrets; UUIDs and hex digests stay redacted. */
const JUNTO_ID = /((?:^|(?<=[^A-Za-z]))[a-z]{2,16}-[0-9A-HJKMNP-TV-Z]{26})(?![0-9A-Za-z])/;
const mixedRun = (run: string): boolean => run.length >= 32 && /[A-Za-z]/.test(run) && /[0-9]/.test(run);
const judgePiece = (piece: string): string =>
  piece.split(JUNTO_ID).map((part, index) => index % 2 === 1 ? part : mixedRun(part) ? REDACTED : part).join("");
const mixed = (run: string): boolean => judgePiece(run) !== run;
const PATH_BOUNDARY = /[\s"'`(=]/;

/** A Junto build directory, <64 hex>-<target>: the public bundle hash, not a secret. */
const BUILD_SEGMENT = /^[0-9a-f]{64}-(?:darwin-arm64|linux-x64)$/;
const judgeSegment = (segment: string): string => BUILD_SEGMENT.test(segment) ? segment : judgePiece(segment);

/**
 * A run with "/" is judged whole, unless it lies in a path: the token around
 * it starts with "/", "~/" or "./" after whitespace, a quote, "(" , "=" or
 * the start of the text, or is a file URL's path. Paths may enter, so a path
 * is judged one segment at a time, wherever the run starts in it (a run
 * often starts after a "." such as "/.junto/").
 */
const judgeRun = (run: string, offset: number, text: string): string => {
  let start = offset;
  while (start > 0 && !PATH_BOUNDARY.test(text[start - 1]!)) start--;
  const token = text.slice(start, offset + run.length);
  const path = token.startsWith("/") || token.startsWith("~/") || token.startsWith("./") || token.startsWith("file:/");
  if (!path) return judgePiece(run);
  return run.split("/").map(judgeSegment).join("/");
};

const stripControls = (text: string): string =>
  text.replace(/\r\n?/g, "\n").replace(ESCAPES, "").replace(CONTROLS, "");

const replaceShapes = (text: string): string =>
  text
    .replace(PRIVATE_KEY, REDACTED)
    .replace(AUTHORIZATION, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(NAMED_VALUE, (_match, name: string) => `${name}${REDACTED}`)
    .replace(TOKEN_SHAPES, REDACTED)
    .replace(UUID, REDACTED)
    .replace(LONG_RUN, (run: string, offset: number, whole: string) => judgeRun(run, offset, whole));

/**
 * Values live on this machine that no failure or log may carry: each
 * generation's resolved secrets and its credential live in the seat's child
 * environment, not this process's, so the launch path registers them here and
 * the generation's end removes them.
 */
const registered = new Map<string, ReadonlyArray<string>>();
/** `owner` names the holder, such as "seat:<bindingId>@<epoch>"; a second call replaces its set. */
export const registerKnownSecrets = (owner: string, values: Iterable<string | undefined>): void => {
  registered.set(owner, [...values].filter((value): value is string => value !== undefined && value.length > 0));
};
export const releaseKnownSecrets = (owner: string): void => { registered.delete(owner); };

/**
 * The known values one launch holds: its secrets and credential (searched from
 * four characters by `redactSecretValues`), and the environment's values from
 * six characters, minus the names the doctrine allows to show. A launch
 * registers this result; it never includes other owners' sets.
 */
export const launchSecretValues = (
  secrets: ReadonlyArray<string | undefined>,
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string | undefined> => {
  const values: Array<string | undefined> = [...secrets];
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value.length < ENVIRONMENT_VALUE_FLOOR) continue;
    if (shownName(name)) continue;
    values.push(value);
  }
  return values;
};

/** Step 3's known values: the caller's, every registered set, and this process's environment. */
export const knownSecretValues = (
  secrets: ReadonlyArray<string | undefined> = [],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyArray<string | undefined> => {
  const values = [...launchSecretValues(secrets, environment)];
  for (const set of registered.values()) values.push(...set);
  return values;
};

/** Steps 2 to 4 over text Junto did not prove clean. */
export const scrubText = (text: string, known: ReadonlyArray<string | undefined> = knownSecretValues()): string =>
  replaceShapes(redactSecretValues(stripControls(text), known));

/** One cause-chain or log message: scrubbed, one line, at most 1 KiB, cut marked. */
export const scrubMessage = (text: string, known?: ReadonlyArray<string | undefined>): string => {
  const line = scrubText(text, known).replace(/\s*\n\s*/g, " ").replace(/\t/g, " ").trim();
  if (line.length <= SCRUBBED_MESSAGE_LIMIT) return line;
  return line.slice(0, SCRUBBED_MESSAGE_LIMIT - CUT.length) + CUT;
};

export interface ScrubbedTail {
  readonly text: string;
  readonly cut: boolean;
}

/**
 * The last lines of a process's error output, made by the machine that read
 * the bytes. Only for processes Junto spawns without a terminal.
 */
export class StderrTail {
  private window = Buffer.alloc(0);
  private trimmed = false;

  push(bytes: Uint8Array): void {
    const next = Buffer.concat([this.window, Buffer.from(bytes)]);
    if (next.length > TAIL_WINDOW_BYTES) {
      this.window = next.subarray(next.length - TAIL_WINDOW_BYTES);
      this.trimmed = true;
    } else {
      this.window = next;
    }
  }

  read(known?: ReadonlyArray<string | undefined>): ScrubbedTail {
    let text = this.window.toString("utf8");
    let cut = this.trimmed;
    // Step 1: a trimmed window's first line may be partial.
    if (this.trimmed) {
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
    const scrubbed = scrubText(text, known).replace(/\n+$/, "");
    if (scrubbed.length === 0) return { text: "", cut };
    let lines = scrubbed.split("\n");
    if (lines.length > TAIL_LINES) { lines = lines.slice(-TAIL_LINES); cut = true; }
    while (lines.length > 1 && Buffer.byteLength(lines.join("\n")) > TAIL_BYTES) { lines.shift(); cut = true; }
    let kept = lines.join("\n");
    if (Buffer.byteLength(kept) > TAIL_BYTES) {
      // One line longer than the bound keeps its end.
      kept = Buffer.from(kept).subarray(-TAIL_BYTES).toString("utf8").replace(/^�+/, "");
      cut = true;
    }
    return { text: kept, cut };
  }
}

/** The last non-empty line of a tail, for a message a person reads. */
export const lastTailLine = (tail: ScrubbedTail | undefined): string | undefined => {
  const lines = tail?.text.split("\n").map(line => line.trim()).filter(line => line.length > 0) ?? [];
  return lines.at(-1);
};
