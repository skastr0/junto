/**
 * External harness-session proof for cold resume.
 *
 * Proof is filesystem (or future CLI) evidence only — never Vellum's
 * process-local capture cache or canvas mint. Absence or IO failure is
 * not-proven (fail-open to pin / fresh session).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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

/** Grok stores sessions under ~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/. */
export const encodeGrokSessionCwd = (cwd: string): string =>
  encodeURIComponent(resolve(cwd));

/** Claude project dir: /Users/foo/bar → -Users-foo-bar */
export const encodeClaudeProjectCwd = (cwd: string): string =>
  resolve(cwd).replace(/\//g, "-");

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
  return false;
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

/** Pin harnesses that mint a UUID at node create. */
export const isPinSessionHarness = (harness: string): boolean =>
  harness === "claude" || harness === "grok";

export type { HarnessId };
