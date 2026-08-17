/**
 * External harness-session proof for cold resume.
 *
 * Proof is filesystem (or future CLI) evidence only — never Vellum Command's
 * process-local capture cache or canvas mint. Absence or IO failure is
 * not-proven (fail-open to pin / fresh session).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { stripIdlessSessionContinue } from "@shared/managed-terminal-launch";
import type { HarnessId } from "@shared/managed-terminal-templates";

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
 * True when harness-local durable state for this session id is present.
 * Errors and missing trees return false (not proven).
 */
export const harnessSessionExists = (probe: SessionExistenceProbe): boolean => {
  const sessionId = probe.sessionId.trim();
  if (!sessionId) return false;
  const harness = probe.harness.trim();
  if (!harness) return false;
  const home = resolveHome(probe.home);
  try {
    switch (harness) {
      case "grok":
        return grokSessionExists(sessionId, probe.cwd, home);
      case "claude":
        return claudeSessionExists(sessionId, probe.cwd, home);
      // Capture harnesses: no pin-mint contract; never claim proof from mint alone.
      case "codex":
        return codexSessionExists(sessionId, home);
      case "hermes":
        return false;
      // Pi is a pin harness; sessions live under
      // ~/.pi/agent/sessions/--<cwd-encoded>--/<ts>_<uuidv7>.jsonl.
      case "pi":
        return piSessionExists(
          sessionId,
          probe.cwd,
          piSessionsRoot(probe, home),
        );
      // Capture harnesses with filesystem cold-proof layouts (2026-08 sweep).
      case "prime-agent":
        return primeAgentSessionExists(sessionId, home);
      case "kimi":
        return kimiSessionExists(
          sessionId,
          sessionsRootWithEnvOverride(
            probe,
            "KIMI_CODE_HOME",
            join(home, ".kimi-code", "sessions"),
          ),
        );
      case "muse":
        return museSessionExists(sessionId, home);
      case "devin":
        return devinSessionExists(sessionId, home);
      case "cursor":
        return cursorSessionExists(sessionId, probe.cwd, cursorDataRoot(probe, home));
      case "agy":
        return agySessionExists(sessionId, home);
      default:
        return false;
    }
  } catch {
    return false;
  }
};

/**
 * Resume argv is allowed only when the caller wants resume AND external proof
 * confirms the id. Unproven → pin/create path (fail open).
 */
export const shouldResumeHarnessSession = (
  wantResume: boolean,
  probe: SessionExistenceProbe,
): boolean => wantResume && harnessSessionExists(probe);

const grokSessionExists = (
  sessionId: string,
  cwd: string | undefined,
  home: string,
): boolean => {
  const root = join(home, ".grok", "sessions");
  if (!isDir(root)) return false;

  if (cwd && cwd.trim()) {
    const absolute = isAbsolute(cwd) ? cwd : resolve(cwd);
    const direct = join(root, encodeGrokSessionCwd(absolute), sessionId);
    if (isDir(direct)) return true;
  }

  // Id may live under any encoded cwd; one-level scan is the harness layout.
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return false;
  }
  for (const enc of entries) {
    const candidate = join(root, enc, sessionId);
    if (isDir(candidate)) return true;
  }
  return false;
};

const claudeSessionExists = (
  sessionId: string,
  cwd: string | undefined,
  home: string,
): boolean => {
  const projects = join(home, ".claude", "projects");
  if (!isDir(projects)) return false;

  const matchInProject = (projectDir: string): boolean => {
    if (isDir(join(projectDir, sessionId))) return true;
    if (isFile(join(projectDir, `${sessionId}.jsonl`))) return true;
    return false;
  };

  if (cwd && cwd.trim()) {
    const project = join(projects, encodeClaudeProjectCwd(cwd));
    if (matchInProject(project)) return true;
  }

  let entries: string[];
  try {
    entries = readdirSync(projects);
  } catch {
    return false;
  }
  for (const enc of entries) {
    if (matchInProject(join(projects, enc))) return true;
  }
  return false;
};

/** Codex rollouts embed the thread id in the filename. */
const codexSessionExists = (sessionId: string, home: string): boolean => {
  const root = join(home, ".codex", "sessions");
  if (!isDir(root)) return false;
  return codexTreeContainsSession(root, sessionId, 0);
};

const codexTreeContainsSession = (
  dir: string,
  sessionId: string,
  depth: number,
): boolean => {
  if (depth > 6) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (name.includes(sessionId)) return true;
    const child = join(dir, name);
    if (isDir(child) && codexTreeContainsSession(child, sessionId, depth + 1)) {
      return true;
    }
  }
  return false;
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

const piSessionExists = (
  sessionId: string,
  cwd: string | undefined,
  root: string,
): boolean => {
  if (!isDir(root)) return false;

  if (cwd && cwd.trim()) {
    const direct = join(root, encodePiSessionCwd(cwd));
    if (isDir(direct) && codexTreeContainsSession(direct, sessionId, 0)) {
      return true;
    }
  }

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return false;
  }
  for (const enc of entries) {
    const candidate = join(root, enc);
    if (isDir(candidate) && codexTreeContainsSession(candidate, sessionId, 0)) {
      return true;
    }
  }
  return false;
};

/**
 * Prime Agent sessions: ~/.prime/agent/sessions/<uuid>.jsonl (flat). Resume
 * accepts id prefix/suffix, so a filename containing the id is proof.
 */
const primeAgentSessionExists = (sessionId: string, home: string): boolean => {
  const root = join(home, ".prime", "agent", "sessions");
  if (!isDir(root)) return false;
  return codexTreeContainsSession(root, sessionId, 0);
};

/**
 * Kimi sessions: $KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/ (dir name
 * equals the session id, ses_<uuid> or session_<uuid>). Probe any workDirKey.
 */
const kimiSessionExists = (sessionId: string, root: string): boolean => {
  if (!isDir(root)) return false;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return false;
  }
  for (const workDirKey of entries) {
    if (isDir(join(root, workDirKey, sessionId))) return true;
  }
  return false;
};

/**
 * Muse sessions: ~/.local/share/muse/sessions/<yyyy>/<mm>/<dd>/<uuid>/. The
 * session id is the date-nested dir name; bounded walk finds it.
 */
const museSessionExists = (sessionId: string, home: string): boolean => {
  const root = join(home, ".local", "share", "muse", "sessions");
  if (!isDir(root)) return false;
  return dirExactlyNamed(root, sessionId, 0);
};

const dirExactlyNamed = (
  dir: string,
  name: string,
  depth: number,
): boolean => {
  if (depth > 4) return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const child = join(dir, entry);
    if (!isDir(child)) continue;
    if (entry === name) return true;
    if (dirExactlyNamed(child, name, depth + 1)) return true;
  }
  return false;
};

/**
 * Devin sessions: ~/.local/share/devin/cli/transcripts/<id>.json and
 * session_locks/<id>.lock; ids are adjective-noun (sample-session). File name
 * equals the id (with extension) — exact match, not contains.
 */
const devinSessionExists = (sessionId: string, home: string): boolean => {
  const root = join(home, ".local", "share", "devin", "cli");
  if (!isDir(root)) return false;
  if (isFile(join(root, "transcripts", `${sessionId}.json`))) return true;
  if (isFile(join(root, "session_locks", `${sessionId}.lock`))) return true;
  return false;
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
 * Cursor sessions: ~/.cursor/projects/<sanitized>/agent-transcripts/<id>/
 * or <id>.jsonl, plus ~/.cursor/chats/<workspaceId>/<id>/meta.json.
 * Sanitize is Claude-ish without the leading dash.
 */
const cursorSessionExists = (
  sessionId: string,
  cwd: string | undefined,
  dataRoot: string,
): boolean => {
  const projects = join(dataRoot, "projects");
  const matchInProject = (projectDir: string): boolean => {
    const transcripts = join(projectDir, "agent-transcripts");
    if (isDir(join(transcripts, sessionId))) return true;
    if (isFile(join(transcripts, `${sessionId}.jsonl`))) return true;
    return false;
  };

  if (cwd && cwd.trim()) {
    if (matchInProject(join(projects, encodeCursorProjectCwd(cwd)))) return true;
  }

  if (isDir(projects)) {
    let entries: string[];
    try {
      entries = readdirSync(projects);
    } catch {
      entries = [];
    }
    for (const enc of entries) {
      if (matchInProject(join(projects, enc))) return true;
    }
  }

  const chats = join(dataRoot, "chats");
  if (!isDir(chats)) return false;
  let workspaces: string[];
  try {
    workspaces = readdirSync(chats);
  } catch {
    return false;
  }
  for (const workspaceId of workspaces) {
    if (isFile(join(chats, workspaceId, sessionId, "meta.json"))) return true;
  }
  return false;
};

/**
 * Antigravity sessions: ~/.gemini/antigravity-cli/brain/<sessionId>/.
 * Verified layout: directory exists and either contains
 * .system_generated/logs/transcript.jsonl or is a directory with entries.
 */
const agySessionExists = (sessionId: string, home: string): boolean => {
  const root = join(home, ".gemini", "antigravity-cli", "brain", sessionId);
  if (!isDir(root)) return false;
  if (isFile(join(root, ".system_generated", "logs", "transcript.jsonl"))) {
    return true;
  }
  try {
    const entries = readdirSync(root);
    return entries.length > 0;
  } catch {
    return false;
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
  // Grok: "fetching session record: session get failed: 404 Not Found"
  if (t.includes("fetching session record") && t.includes("404")) return true;
  if (t.includes("resume") && t.includes("404") && t.includes("not found")) return true;
  // Grok pin-create against a session this station already made.
  if (t.includes("already in use") && t.includes("session")) return true;
  return false;
};

export type HarnessSessionArgv = {
  readonly harness: "grok" | "claude" | "pi";
  readonly sessionId: string;
  readonly mode: "pin" | "resume";
};

const pinHarnessFromBinary = (
  file: string | undefined,
): HarnessSessionArgv["harness"] | undefined => {
  if (!file) return undefined;
  const name = basename(file);
  if (name === "grok") return "grok";
  if (name === "claude") return "claude";
  if (name === "pi") return "pi";
  return undefined;
};

const resumeFlagFor = (harness: HarnessSessionArgv["harness"]): string =>
  harness === "claude" ? "--resume" : "-r";

/** Read pin/resume id from spawn argv. Pin is create; resume is reclaim. */
export const parseHarnessSessionArgv = (
  argv: ReadonlyArray<string>,
): HarnessSessionArgv | undefined => {
  const harness = pinHarnessFromBinary(argv[0]);
  if (!harness) return undefined;
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "-r" || tok === "--resume") {
      const id = argv[i + 1];
      if (id && !id.startsWith("-")) {
        return { harness, sessionId: id, mode: "resume" };
      }
    }
    if (tok === "--session-id") {
      const id = argv[i + 1];
      if (id && !id.startsWith("-")) {
        return { harness, sessionId: id, mode: "pin" };
      }
    }
    if (tok.startsWith("--session-id=")) {
      const id = tok.slice("--session-id=".length);
      if (id) return { harness, sessionId: id, mode: "pin" };
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
  for (let i = 1; i < out.length; i += 1) {
    if (out[i] === "--session-id" && out[i + 1] === parsed.sessionId) {
      out[i] = resumeFlag;
      return stripIdlessSessionContinue(out);
    }
    if (out[i] === `--session-id=${parsed.sessionId}`) {
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
    if (tok === "-r" || tok === "--resume") return true;
    if (tok === "resume" && i > 0) return true;
  }
  return false;
};

/** Pin harnesses that mint a UUID at node create. Pi pins via --session-id. */
export const isPinSessionHarness = (harness: string): boolean =>
  harness === "claude" || harness === "grok" || harness === "pi";

export type { HarnessId };
