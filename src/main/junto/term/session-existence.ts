/**
 * External harness-session proof for cold resume.
 *
 * Proof is filesystem (or future CLI) evidence only — never Junto's
 * process-local capture cache or canvas mint. Absence or IO failure is
 * not-proven (fail-open to pin / fresh session).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { basename, isAbsolute, join, resolve } from "node:path";
import { stripIdlessSessionContinue } from "@shared/managed-terminal-launch";
import { isFxSessionId } from "./templates/fx-session";
import { isOmpSessionId, ompSessionsDir } from "./templates/omp-session";
import {
  templateFor,
  type HarnessId,
} from "@shared/managed-terminal-templates";

export type SessionExistenceProbe = {
  readonly harness: string;
  readonly sessionId: string;
  readonly cwd?: string;
  /** Override home for tests. */
  readonly home?: string;
};

/** Test-only home root for FS probes (not a session-existence cache). */
let homeForTest: string | undefined;
export const __setSessionExistenceHomeForTest = (home: string | undefined): void => {
  homeForTest = home;
};

const resolveHome = (home?: string): string => home ?? homeForTest ?? homedir();

/**
 * Sessions root with a harness env override (KIMI_CODE_HOME, PI_CODING_AGENT_DIR
 * — both are the parent dir of `sessions`). The override applies only when the
 * caller did not pin a root (explicit probe.home or the test home root); pinned
 * roots win so tests stay hermetic against ambient machine env.
 */
const sessionsRootWithEnvOverride = (
  probe: SessionExistenceProbe,
  envKey: string,
  fallbackRoot: string,
): string => {
  if (probe.home !== undefined || homeForTest !== undefined) {
    return fallbackRoot;
  }
  const env = process.env[envKey]?.trim();
  return env ? join(env, "sessions") : fallbackRoot;
};

/** Grok stores sessions under ~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/. */
export const encodeGrokSessionCwd = (cwd: string): string =>
  encodeURIComponent(resolve(cwd));

/** Claude project dir: /Users/foo/bar → -Users-foo-bar */
export const encodeClaudeProjectCwd = (cwd: string): string =>
  resolve(cwd).replace(/\//g, "-");

/** Cursor project dir: /Users/foo/bar → Users-foo-bar (no leading dash). */
export const encodeCursorProjectCwd = (cwd: string): string =>
  resolve(cwd).replace(/^\//, "").replace(/\//g, "-");

/**
 * Pi cwd encoding for the session dir: strip leading "/", map "/" and ":" to
 * "-", wrap in "--…--". /Users/me/proj → --Users-me-proj--
 */
export const encodePiSessionCwd = (cwd: string): string => {
  const absolute = isAbsolute(cwd) ? cwd : resolve(cwd);
  return `--${absolute.replace(/^\//, "").replace(/[/:]/g, "-")}--`;
};

const isDir = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Where the harness keeps this session on disk: the transcript file or session
 * directory an agent can open itself, or the harness's own session database
 * when that is the only record (Hermes, Devin). The same probe as
 * `harnessSessionExists`, which is this locator answering at all. Errors and
 * missing trees return undefined (not found).
 */
export const harnessSessionLocation = (
  probe: SessionExistenceProbe,
): string | undefined => {
  const sessionId = probe.sessionId.trim();
  if (!sessionId) return undefined;
  const harness = probe.harness.trim();
  if (!harness) return undefined;
  const home = resolveHome(probe.home);
  try {
    switch (harness) {
      case "grok":
        return grokSessionLocation(sessionId, probe.cwd, home);
      case "claude":
        return claudeSessionLocation(sessionId, probe.cwd, home);
      // Capture harnesses: no pin-mint contract; never claim proof from mint alone.
      case "codex":
        return codexSessionLocation(sessionId, home);
      case "hermes":
        return hermesSessionLocation(sessionId, home);
      // Pi is a pin harness; sessions live under
      // ~/.pi/agent/sessions/--<cwd-encoded>--/<ts>_<uuidv7>.jsonl.
      case "pi":
        return piSessionLocation(
          sessionId,
          probe.cwd,
          piSessionsRoot(probe, home),
        );
      // Capture harnesses with filesystem cold-proof layouts (2026-08 sweep).
      case "prime-agent":
        return primeAgentSessionLocation(sessionId, home);
      case "kimi":
        return kimiSessionLocation(
          sessionId,
          sessionsRootWithEnvOverride(
            probe,
            "KIMI_CODE_HOME",
            join(home, ".kimi-code", "sessions"),
          ),
        );
      case "muse":
        return museSessionLocation(sessionId, home);
      case "fx":
        return fxSessionLocation(sessionId, home);
      case "omp":
        return ompSessionLocation(sessionId, probe.cwd, home);
      case "devin":
        return devinSessionLocation(sessionId, home);
      case "cursor":
        return cursorSessionLocation(sessionId, probe.cwd, cursorDataRoot(probe, home));
      case "agy":
        return agySessionLocation(sessionId, home);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
};

/**
 * True when harness-local durable state for this session id is present.
 * Errors and missing trees return false (not proven).
 */
export const harnessSessionExists = (probe: SessionExistenceProbe): boolean =>
  harnessSessionLocation(probe) !== undefined;

/**
 * Resume argv is allowed only when the caller wants resume AND external proof
 * confirms the id. Unproven → pin/create path (fail open).
 */
export const shouldResumeHarnessSession = (
  wantResume: boolean,
  probe: SessionExistenceProbe,
): boolean => wantResume && harnessSessionExists(probe);

const grokSessionLocation = (
  sessionId: string,
  cwd: string | undefined,
  home: string,
): string | undefined => {
  const root = join(home, ".grok", "sessions");
  if (!isDir(root)) return undefined;

  if (cwd && cwd.trim()) {
    const absolute = isAbsolute(cwd) ? cwd : resolve(cwd);
    const direct = join(root, encodeGrokSessionCwd(absolute), sessionId);
    if (isDir(direct)) return direct;
  }

  // Id may live under any encoded cwd; one-level scan is the harness layout.
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const enc of entries) {
    const candidate = join(root, enc, sessionId);
    if (isDir(candidate)) return candidate;
  }
  return undefined;
};

const claudeSessionLocation = (
  sessionId: string,
  cwd: string | undefined,
  home: string,
): string | undefined => {
  const projects = join(home, ".claude", "projects");
  if (!isDir(projects)) return undefined;

  // The transcript is the jsonl; the id-named directory holds its sidecars.
  const matchInProject = (projectDir: string): string | undefined => {
    const transcript = join(projectDir, `${sessionId}.jsonl`);
    if (isFile(transcript)) return transcript;
    const dir = join(projectDir, sessionId);
    if (isDir(dir)) return dir;
    return undefined;
  };

  if (cwd && cwd.trim()) {
    const found = matchInProject(join(projects, encodeClaudeProjectCwd(cwd)));
    if (found) return found;
  }

  let entries: string[];
  try {
    entries = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const enc of entries) {
    const found = matchInProject(join(projects, enc));
    if (found) return found;
  }
  return undefined;
};

/**
 * Hermes session ids are `%Y%m%d_%H%M%S_<hex6>` — the same value the harness
 * exports as `HERMES_SESSION_ID` into the agent shell. Shape-checking before
 * the query keeps scraped PTY text from reaching the database at all.
 */
export const isHermesSessionId = (value: string): boolean =>
  /^\d{8}_\d{6}_[0-9a-f]{6}$/i.test(value.trim());

/**
 * Hermes sessions live in ONE place: `~/.hermes/state.db`.
 *
 * The jsonl transcripts under `~/.hermes/sessions/` are retired — v0.20.4
 * writes nothing there, so the newest file on disk predates the sessions a seat
 * is actually resuming, and a filesystem probe would report "not proven" for
 * every live session. The database is the only current receipt.
 *
 * Opened strictly read-only: this never creates the file, never migrates it,
 * and never takes a write lock on a database the operator's own Hermes is
 * using. Any failure — missing file, locked, unexpected schema — is
 * not-proven, which fails open to a fresh session rather than a dead resume.
 */
const hermesSessionLocation = (sessionId: string, home: string): string | undefined => {
  if (!isHermesSessionId(sessionId)) return undefined;
  const path = join(home, ".hermes", "state.db");
  if (!isFile(path)) return undefined;

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      open: true,
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: 2_000,
    });
    // The id column has been `id` in every build probed; `session_id` is tried
    // only if the first statement cannot prepare, so a schema rename degrades
    // to a second attempt instead of a silent false.
    for (const column of ["id", "session_id"] as const) {
      try {
        const row = database
          .prepare(`SELECT 1 AS present FROM sessions WHERE ${column} = ? LIMIT 1`)
          .get(sessionId);
        return row === undefined ? undefined : path;
      } catch {
        // try the next column name
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    try {
      database?.close();
    } catch {
      // best-effort
    }
  }
};

/** Codex rollouts embed the thread id in the filename. */
const codexSessionLocation = (sessionId: string, home: string): string | undefined => {
  const root = join(home, ".codex", "sessions");
  if (!isDir(root)) return undefined;
  return codexTreeFindSession(root, sessionId, 0);
};

const codexTreeFindSession = (
  dir: string,
  sessionId: string,
  depth: number,
): string | undefined => {
  if (depth > 6) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    const child = join(dir, name);
    if (name.includes(sessionId)) return child;
    if (isDir(child)) {
      const found = codexTreeFindSession(child, sessionId, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
};

/**
 * Pi sessions: ~/.pi/agent/sessions/--<cwd-encoded>--/<ISO-ts>_<uuidv7>.jsonl.
 * Session id is the uuidv7 part of the filename; resume accepts partial ids,
 * so a filename containing the id is proof. Prefer the cwd-encoded dir when
 * cwd is given, then fall back to scanning every cwd dir (superset).
 */
/**
 * Pi sessions root. Default ~/.pi/agent/sessions. Env overrides (production
 * only — pinned probe roots win): PI_CODING_AGENT_SESSION_DIR replaces the
 * root outright; PI_CODING_AGENT_DIR relocates the agent dir (~/.pi/agent),
 * so sessions live under <agentDir>/sessions.
 */
const piSessionsRoot = (
  probe: SessionExistenceProbe,
  home: string,
): string => {
  if (probe.home === undefined && homeForTest === undefined) {
    const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
    if (sessionDir) return sessionDir;
    const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
    if (agentDir) return join(agentDir, "sessions");
  }
  return join(home, ".pi", "agent", "sessions");
};

const piSessionLocation = (
  sessionId: string,
  cwd: string | undefined,
  root: string,
): string | undefined => {
  if (!isDir(root)) return undefined;

  if (cwd && cwd.trim()) {
    const direct = join(root, encodePiSessionCwd(cwd));
    const found = isDir(direct) ? codexTreeFindSession(direct, sessionId, 0) : undefined;
    if (found) return found;
  }

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const enc of entries) {
    const candidate = join(root, enc);
    const found = isDir(candidate) ? codexTreeFindSession(candidate, sessionId, 0) : undefined;
    if (found) return found;
  }
  return undefined;
};

/**
 * Prime Agent sessions: ~/.prime/agent/sessions/<uuid>.jsonl (flat). Resume
 * accepts id prefix/suffix, so a filename containing the id is proof.
 */
const primeAgentSessionLocation = (sessionId: string, home: string): string | undefined => {
  const root = join(home, ".prime", "agent", "sessions");
  if (!isDir(root)) return undefined;
  return codexTreeFindSession(root, sessionId, 0);
};

/**
 * Kimi sessions: $KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/ (dir name
 * equals the session id, `ses_<uuid>` or `session_<uuid>`). Probe any
 * workDirKey. Verified on 0.34.0 — this directory is the proof `-S <id>`
 * reads. The welcome-card `Session:` line is blank at spawn (0.33.0+ lazy
 * creation) and is never treated as a startup receipt; a later scrape is
 * only stored after this probe succeeds.
 */
const kimiSessionLocation = (sessionId: string, root: string): string | undefined => {
  if (!isDir(root)) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const workDirKey of entries) {
    const dir = join(root, workDirKey, sessionId);
    if (isDir(dir)) return dir;
  }
  return undefined;
};

/**
 * Oh My Pi sessions: one jsonl per session under the encoded-cwd directory.
 * Proof needs the cwd, because that directory IS the workspace.
 */
const ompSessionLocation = (
  sessionId: string,
  cwd: string | undefined,
  home: string,
): string | undefined => {
  const id = sessionId.trim();
  if (!isOmpSessionId(id) || !cwd) return undefined;
  try {
    const dir = ompSessionsDir(cwd, home);
    const name = readdirSync(dir).find((entry) => entry.includes(id));
    return name === undefined ? undefined : join(dir, name);
  } catch {
    return undefined;
  }
};

/**
 * fx sessions: ~/.fx/sessions/<id>/, flat, id-named. Proof is the directory —
 * an id captured from the index still has to exist on disk before a seat is
 * allowed to resume it.
 */
const fxSessionLocation = (sessionId: string, home: string): string | undefined => {
  const id = sessionId.trim();
  if (!isFxSessionId(id)) return undefined;
  const dir = join(home, ".fx", "sessions", id);
  return isDir(dir) ? dir : undefined;
};

/**
 * Muse sessions: ~/.local/share/muse/sessions/<yyyy>/<mm>/<dd>/<uuid>/. The
 * session id is the date-nested dir name; bounded walk finds it.
 */
const museSessionLocation = (sessionId: string, home: string): string | undefined => {
  const root = join(home, ".local", "share", "muse", "sessions");
  if (!isDir(root)) return undefined;
  return findDirNamed(root, sessionId, 0);
};

const findDirNamed = (
  dir: string,
  name: string,
  depth: number,
): string | undefined => {
  if (depth > 4) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const child = join(dir, entry);
    if (!isDir(child)) continue;
    if (entry === name) return child;
    const found = findDirNamed(child, name, depth + 1);
    if (found) return found;
  }
  return undefined;
};

/**
 * Devin sessions: `~/.local/share/devin/cli/sessions.db`, table `sessions`,
 * keyed by the adjective-noun slug (`sample-session`). Ids are exact.
 *
 * The database is the proof because it is exactly what `-r` reads. Probed on
 * 3000.4.16:
 *
 * - `session_locks/<id>.lock` is NOT proof. Locks are written at startup and
 *   never removed, so they outlive their sessions — and `devin -r <slug>` on a
 *   lock-only slug answers `No session found matching '<slug>'`. Treating a
 *   lock as proof pins a seat to a session that cannot be resumed.
 * - `transcripts/<id>.json` is a legacy fallback: recent sessions (including
 *   ones resumable right now) have no transcript file at all, so it can prove
 *   an id but never disprove one.
 *
 * Opened read-only: never created, never migrated, never write-locked while
 * the operator's own Devin is running. Any failure is not-proven, which fails
 * open to a fresh session rather than a dead resume.
 */
const devinSessionLocation = (sessionId: string, home: string): string | undefined => {
  const root = join(home, ".local", "share", "devin", "cli");
  if (!isDir(root)) return undefined;
  const transcript = join(root, "transcripts", `${sessionId}.json`);
  if (isFile(transcript)) return transcript;

  const path = join(root, "sessions.db");
  if (!isFile(path)) return undefined;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      open: true,
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: 2_000,
    });
    const row = database
      .prepare("SELECT 1 AS present FROM sessions WHERE id = ? LIMIT 1")
      .get(sessionId);
    return row === undefined ? undefined : path;
  } catch {
    return undefined;
  } finally {
    try {
      database?.close();
    } catch {
      // best-effort
    }
  }
};

/**
 * Cursor data root. Default ~/.cursor. CURSOR_DATA_DIR replaces the root
 * outright when the caller did not pin probe.home or the test home.
 */
const cursorDataRoot = (
  probe: SessionExistenceProbe,
  home: string,
): string => {
  if (probe.home === undefined && homeForTest === undefined) {
    const env = process.env.CURSOR_DATA_DIR?.trim();
    if (env) return env;
  }
  return join(home, ".cursor");
};

/**
 * Cursor sessions. The durable receipt is
 * `~/.cursor/chats/<workspaceHash>/<id>/meta.json`, written once the session
 * has a first turn — checked first because it is the one path re-probed live
 * (2026-08-25). `~/.cursor/projects/<sanitized>/agent-transcripts/…` is kept as
 * a second look for older layouts; sanitize is Claude-ish without the leading
 * dash.
 *
 * A pinned id that has not taken a turn yet is legitimately not proven here,
 * and that is the right answer: resume would have nothing to resume, so the
 * spawn falls open to creating the session with that same pinned id.
 */
const cursorSessionLocation = (
  sessionId: string,
  cwd: string | undefined,
  dataRoot: string,
): string | undefined => {
  const chatsRoot = join(dataRoot, "chats");
  if (isDir(chatsRoot)) {
    let workspaceDirs: string[];
    try {
      workspaceDirs = readdirSync(chatsRoot);
    } catch {
      workspaceDirs = [];
    }
    for (const workspaceId of workspaceDirs) {
      const chat = join(chatsRoot, workspaceId, sessionId);
      if (isFile(join(chat, "meta.json"))) return chat;
    }
  }

  const projects = join(dataRoot, "projects");
  const matchInProject = (projectDir: string): string | undefined => {
    const transcripts = join(projectDir, "agent-transcripts");
    const dir = join(transcripts, sessionId);
    if (isDir(dir)) return dir;
    const file = join(transcripts, `${sessionId}.jsonl`);
    if (isFile(file)) return file;
    return undefined;
  };

  if (cwd && cwd.trim()) {
    const found = matchInProject(join(projects, encodeCursorProjectCwd(cwd)));
    if (found) return found;
  }

  if (isDir(projects)) {
    let entries: string[];
    try {
      entries = readdirSync(projects);
    } catch {
      entries = [];
    }
    for (const enc of entries) {
      const found = matchInProject(join(projects, enc));
      if (found) return found;
    }
  }

  return undefined;
};

/**
 * Antigravity sessions: ~/.gemini/antigravity-cli/brain/<sessionId>/.
 * Verified layout: directory exists and either contains
 * .system_generated/logs/transcript.jsonl or is a directory with entries.
 */
const agySessionLocation = (sessionId: string, home: string): string | undefined => {
  const root = join(home, ".gemini", "antigravity-cli", "brain", sessionId);
  if (!isDir(root)) return undefined;
  const transcript = join(root, ".system_generated", "logs", "transcript.jsonl");
  if (isFile(transcript)) return transcript;
  try {
    return readdirSync(root).length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Harness-printed resume failure (Grok remote 404, missing Claude session, …).
 * Used for fail-open: abandon -r and open a fresh pin session.
 */
export const isHarnessResumeFailureText = (text: string): boolean => {
  const t = text.toLowerCase();
  if (!t) return false;
  if (t.includes("failed to restore session")) return true;
  if (t.includes("session get failed")) return true;
  if (t.includes("no conversation found") && t.includes("resume")) return true;
  if (t.includes("session not found") && (t.includes("resume") || t.includes("restore"))) {
    return true;
  }
  // Devin: "Error: No session found matching 'ionized-pluto'" (3000.4.16).
  if (t.includes("no session found matching")) return true;
  // Grok: "fetching session record: session get failed: 404 Not Found"
  if (t.includes("fetching session record") && t.includes("404")) return true;
  if (t.includes("resume") && t.includes("404") && t.includes("not found")) return true;
  // Grok pin-create against a session this station already made.
  if (t.includes("already in use") && t.includes("session")) return true;
  return false;
};

/**
 * The pin harnesses: the four whose template declares a `sessionIdFlag`, so
 * their session id can be read back off spawn argv. This tuple is the type.
 * Each harness's binary comes from its template rather than a second list, so
 * renaming a CLI cannot leave a stale name behind: Cursor's moved from the
 * `agent` compatibility alias to its own `cursor-agent`.
 */
const PIN_HARNESSES = ["claude", "grok", "pi", "cursor"] as const;

export type HarnessSessionArgv = {
  readonly harness: (typeof PIN_HARNESSES)[number];
  readonly sessionId: string;
  readonly mode: "pin" | "resume";
};

const pinHarnessFromBinary = (
  file: string | undefined,
): HarnessSessionArgv["harness"] | undefined => {
  if (!file) return undefined;
  const name = basename(file);
  for (const harness of PIN_HARNESSES) {
    if (templateFor(harness).argvSpec.binary === name) return harness;
  }
  return undefined;
};

/**
 * The harness's own named-resume flag, read from its template so this low-level
 * reclaim path cannot drift from the shape `buildArgv` emits.
 *
 * It drifted once: every harness but Claude got `-r`, and on Pi `-r`
 * (`--resume`) means "Select a session to resume" — the interactive picker,
 * verified on 0.84.2 — so a reclaimed seat opened a menu instead of its own
 * session. Pi's named form is `--session <path|id>`, which the template
 * already declared.
 */
const resumeFlagFor = (harness: HarnessSessionArgv["harness"]): string =>
  templateFor(harness).argvSpec.resumeFlag ?? "-r";

/**
 * The token that CREATES a named session for this harness, read from the
 * template rather than assumed: `--session-id` for claude/grok/pi,
 * `--new-session-id` for cursor.
 */
const pinFlagFor = (
  harness: HarnessSessionArgv["harness"],
): string | undefined => templateFor(harness).argvSpec.sessionIdFlag;

/**
 * Named-resume tokens across the pin harnesses: `-r` / `--resume` (grok,
 * claude) and Pi's `--session`. `--session-id` and `--session-dir` are NOT
 * resume — the first is a pin that creates the session if missing, the second
 * is storage configuration — so this matches whole tokens only.
 */
const isNamedResumeToken = (token: string): boolean =>
  token === "-r" || token === "--resume" || token === "--session";

/** Read pin/resume id from spawn argv. Pin is create; resume is reclaim. */
export const parseHarnessSessionArgv = (
  argv: ReadonlyArray<string>,
): HarnessSessionArgv | undefined => {
  const harness = pinHarnessFromBinary(argv[0]);
  if (!harness) return undefined;
  const pinFlag = pinFlagFor(harness);
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (isNamedResumeToken(tok)) {
      const id = argv[i + 1];
      if (id && !id.startsWith("-")) {
        return { harness, sessionId: id, mode: "resume" };
      }
    }
    if (pinFlag) {
      if (tok === pinFlag) {
        const id = argv[i + 1];
        if (id && !id.startsWith("-")) {
          return { harness, sessionId: id, mode: "pin" };
        }
      }
      if (tok.startsWith(`${pinFlag}=`)) {
        const id = tok.slice(pinFlag.length + 1);
        if (id) return { harness, sessionId: id, mode: "pin" };
      }
    }
  }
  return undefined;
};

/**
 * This host created the harness session. After a station restart the in-memory
 * seat table is empty, but the session files remain. Keep this as a defense for
 * lower-level/raw pin argv: convert a locally proven orphaned pin to resume so
 * the host reclaims rather than duplicates it. Actor occupation now resolves
 * named-session intent on this host before reaching this fallback.
 */
export const reclaimOrphanedHarnessArgv = (
  argv: ReadonlyArray<string>,
  cwd?: string,
): string[] => {
  const parsed = parseHarnessSessionArgv(argv);
  if (!parsed || parsed.mode === "resume") {
    return stripIdlessSessionContinue(argv);
  }
  if (
    !harnessSessionExists({
      harness: parsed.harness,
      sessionId: parsed.sessionId,
      ...(cwd === undefined ? {} : { cwd }),
    })
  ) {
    return stripIdlessSessionContinue(argv);
  }
  const out = [...argv];
  const resumeFlag = resumeFlagFor(parsed.harness);
  const pinFlag = pinFlagFor(parsed.harness);
  if (!pinFlag) return stripIdlessSessionContinue(out);
  for (let i = 1; i < out.length; i += 1) {
    if (out[i] === pinFlag && out[i + 1] === parsed.sessionId) {
      out[i] = resumeFlag;
      return stripIdlessSessionContinue(out);
    }
    if (out[i] === `${pinFlag}=${parsed.sessionId}`) {
      out.splice(i, 1, resumeFlag, parsed.sessionId);
      return stripIdlessSessionContinue(out);
    }
  }
  return stripIdlessSessionContinue(out);
};

export const launchArgvUsesResume = (
  argv: ReadonlyArray<string> | undefined,
): boolean => {
  if (!argv || argv.length === 0) return false;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    // Pi's `--session <id>` is a resume as much as `-r` is; missing it left the
    // isolation guard and the dead-resume fail-open blind to every Pi resume.
    if (isNamedResumeToken(tok)) return true;
    if (tok === "resume" && i > 0) return true;
  }
  return false;
};

/**
 * Pin harnesses that mint a UUID at node create. Pi pins via `--session-id`,
 * Cursor via `--new-session-id`.
 */
export const isPinSessionHarness = (harness: string): boolean =>
  harness === "claude" ||
  harness === "grok" ||
  harness === "pi" ||
  harness === "cursor";

export type { HarnessId };
