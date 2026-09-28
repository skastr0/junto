/**
 * Claude Code reports its own context window only to its status line: every
 * render pipes a JSON payload to the `statusLine` command on stdin, carrying
 * `context_window.context_window_size` and `used_percentage`. The transcript
 * never records the window, so this is the one place the harness says it.
 *
 * Every Claude seat launches with `--settings <file>` naming a status line
 * Junto owns. That command is a tiny POSIX sh + awk recorder: it writes
 * `{session_id, context_window_size, used_percentage, total_input_tokens, at}`
 * to the seat's own file (owner-only, replaced atomically), then runs the
 * operator's own `statusLine` command on the same stdin and prints its output
 * unchanged, so their status line keeps working. With none configured it
 * prints nothing. No network, no JSON tool: awk ships everywhere Junto runs.
 *
 * The operator's command is read from their Claude settings when the seat
 * launches (local project, then project, then user, the precedence Claude
 * itself applies below `--settings`). Everything lives under
 * `<JUNTO_HOME>/.junto/content/claude-status/`; the operator's files are
 * never written.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveJuntoHome } from "@shared/junto-home";
import { agentFileKey } from "./agent-file-spec";

export const claudeStatusRoot = (home: string = resolveJuntoHome()): string =>
  join(home, ".junto", "content", "claude-status");

export const CLAUDE_STATUS_RECORDER = "recorder.sh" as const;

export type ClaudeStatusPaths = {
  readonly recorder: string;
  /** The `--settings` file handed to Claude. */
  readonly settings: string;
  /** The recorder's output, read by token pressure. */
  readonly record: string;
  /** The operator's own status line command, when they have one. */
  readonly chain: string;
};

export const claudeStatusPaths = (
  seatRef: string,
  home: string = resolveJuntoHome(),
): ClaudeStatusPaths | undefined => {
  const key = agentFileKey(seatRef);
  if (key === undefined) return undefined;
  const root = claudeStatusRoot(home);
  return {
    recorder: join(root, CLAUDE_STATUS_RECORDER),
    settings: join(root, `${key}.settings.json`),
    record: join(root, `${key}.json`),
    chain: join(root, `${key}.statusline.sh`),
  };
};

/**
 * `$1` record file, `$2` the operator's command file (optional). The record
 * is written first: Claude cancels a status line still running when the next
 * render starts, and a slow operator command must not cost the reading.
 * awk walks the JSON by key path, so `rate_limits.*.used_percentage` never
 * passes for the context's. A payload without a session id or a window
 * writes nothing.
 */
export const CLAUDE_STATUS_RECORDER_SCRIPT = `#!/bin/sh
# Junto: records Claude Code's own context window for token pressure, then
# runs the operator's status line unchanged. Rewritten on every Claude launch.
umask 077
payload=$(cat)
record=$1
if [ -n "$record" ]; then
  tmp="$record.$$"
  if printf '%s' "$payload" | awk -v at="$(date +%s)" '
function ws() { while (i <= n && index(" \\t\\r\\n", substr(s, i, 1)) > 0) i++ }
function str(   c, start) {
  i++; start = i
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\\\\") { i += 2; continue }
    if (c == "\\"") { i++; return substr(s, start, i - 1 - start) }
    i++
  }
  return substr(s, start)
}
function scalar(   start) {
  start = i
  while (i <= n && index(",}] \\t\\r\\n", substr(s, i, 1)) == 0) i++
  return substr(s, start, i - start)
}
function value(path,   c, k) {
  ws(); c = substr(s, i, 1)
  if (c == "{") {
    i++; ws()
    if (substr(s, i, 1) == "}") { i++; return }
    while (i <= n) {
      ws(); k = str(); ws(); i++
      value(path "." k)
      ws(); c = substr(s, i, 1); i++
      if (c != ",") return
    }
    return
  }
  if (c == "[") {
    i++; ws()
    if (substr(s, i, 1) == "]") { i++; return }
    while (i <= n) {
      value(path "[]")
      ws(); c = substr(s, i, 1); i++
      if (c != ",") return
    }
    return
  }
  if (c == "\\"") { got[path] = "\\"" str() "\\""; return }
  got[path] = scalar()
}
function num(v) { return v ~ /^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$/ ? v : "null" }
{ s = s $0 "\\n" }
END {
  n = length(s); i = 1; value("")
  sid = got[".session_id"]; size = got[".context_window.context_window_size"]
  if (sid !~ /^"[^"]+"$/ || size !~ /^[0-9]+$/ || size + 0 <= 0) exit 1
  printf "{\\"session_id\\":%s,\\"context_window_size\\":%s,\\"used_percentage\\":%s,\\"total_input_tokens\\":%s,\\"at\\":%s}\\n", sid, size, num(got[".context_window.used_percentage"]), num(got[".context_window.total_input_tokens"]), at
}' > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$record"
  else
    rm -f "$tmp"
  fi
fi
if [ -n "$2" ] && [ -f "$2" ]; then
  printf '%s\\n' "$payload" | /bin/sh "$2"
fi
`;

/** POSIX single-quoted word. */
export const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const readJsonObject = (path: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export type UserStatusLine = {
  readonly command: string;
  /** Everything else the operator set (`padding`, `refreshInterval`, ...), carried over. */
  readonly extras: Readonly<Record<string, unknown>>;
};

/**
 * The operator's own `statusLine`, from the highest-precedence settings file
 * below `--settings` that sets one: `<cwd>/.claude/settings.local.json`,
 * `<cwd>/.claude/settings.json`, then `<config>/settings.json`.
 */
export const userStatusLine = (input: {
  readonly cwd?: string;
  readonly configDir?: string;
}): UserStatusLine | undefined => {
  const configDir = input.configDir?.trim() || join(homedir(), ".claude");
  const files = [
    ...(input.cwd?.trim()
      ? [join(input.cwd, ".claude", "settings.local.json"), join(input.cwd, ".claude", "settings.json")]
      : []),
    join(configDir, "settings.json"),
  ];
  for (const file of files) {
    const statusLine = readJsonObject(file)?.statusLine;
    if (typeof statusLine !== "object" || statusLine === null || Array.isArray(statusLine)) continue;
    const { type: _type, command, ...extras } = statusLine as Record<string, unknown>;
    if (typeof command !== "string" || command.trim().length === 0) continue;
    return { command, extras };
  }
  return undefined;
};

/** The `--settings` body: our recorder, with the operator's own layout keys. */
export const buildClaudeStatusSettings = (
  paths: ClaudeStatusPaths,
  user: UserStatusLine | undefined,
): { readonly statusLine: Record<string, unknown> } => ({
  statusLine: {
    ...(user?.extras ?? {}),
    type: "command",
    command: [paths.recorder, paths.record, ...(user ? [paths.chain] : [])].map(shQuote).join(" "),
  },
});

const writePrivate = (path: string, body: string, mode: number): void => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { encoding: "utf8", mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
};

/**
 * Write the recorder, the operator's command, and the seat's settings, and
 * return the settings path for `--settings`. Undefined when the seat ref is
 * unusable or a write fails: the seat then launches without it and reports
 * its window as unknown.
 */
export const writeClaudeStatusSettings = (input: {
  readonly seatRef: string;
  readonly cwd?: string;
  readonly configDir?: string;
  readonly home?: string;
}): string | undefined => {
  const paths = claudeStatusPaths(input.seatRef, input.home);
  if (paths === undefined) return undefined;
  const user = userStatusLine(input);
  try {
    mkdirSync(claudeStatusRoot(input.home), { recursive: true, mode: 0o700 });
    chmodSync(claudeStatusRoot(input.home), 0o700);
    writePrivate(paths.recorder, CLAUDE_STATUS_RECORDER_SCRIPT, 0o700);
    if (user !== undefined) writePrivate(paths.chain, `${user.command}\n`, 0o600);
    writePrivate(paths.settings, `${JSON.stringify(buildClaudeStatusSettings(paths, user), null, 2)}\n`, 0o600);
    return paths.settings;
  } catch {
    return undefined;
  }
};

// ── Reading the record ──────────────────────────────────────────────────────

export type ClaudeStatusRecord = {
  readonly sessionId: string;
  readonly contextWindowSize: number;
  /** Null early in a session and right after `/compact`. */
  readonly usedPercentage?: number;
  readonly totalInputTokens?: number;
  /** Epoch ms of the render that wrote it. */
  readonly at: number;
};

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const parseClaudeStatusRecord = (text: string): ClaudeStatusRecord | undefined => {
  let row: unknown;
  try {
    row = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof row !== "object" || row === null) return undefined;
  const record = row as Record<string, unknown>;
  const sessionId = typeof record.session_id === "string" ? record.session_id : undefined;
  const size = finite(record.context_window_size);
  const at = finite(record.at);
  if (sessionId === undefined || sessionId.length === 0 || size === undefined || size <= 0 || at === undefined) {
    return undefined;
  }
  const usedPercentage = finite(record.used_percentage);
  const totalInputTokens = finite(record.total_input_tokens);
  return {
    sessionId,
    contextWindowSize: size,
    ...(usedPercentage !== undefined ? { usedPercentage } : {}),
    ...(totalInputTokens !== undefined ? { totalInputTokens } : {}),
    at: at * 1000,
  };
};
