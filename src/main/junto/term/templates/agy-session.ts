/**
 * Antigravity CLI (`agy`) session discovery.
 *
 * `agy` mints its own conversation ID and does not print it to PTY output:
 *   ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl
 *
 * Workspace association is recorded in ~/.gemini/antigravity-cli/conversation_summaries.db
 * and ~/.gemini/antigravity-cli/history.jsonl when present. In headless/test fixtures
 * where only brain/ is seeded, directory creation/modification time provides the
 * start-time floor.
 *
 * Read-only: inspection of ~/.gemini/antigravity-cli without modifying files.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONV_SLUG = /^conv-[0-9a-z_-]+$/i;

/** Validate whether a string is a valid agy conversation/session ID. */
export const isAgySessionId = (value: string): boolean => {
  const trimmed = value.trim();
  return (
    SESSION_UUID.test(trimmed) ||
    CONV_SLUG.test(trimmed) ||
    (trimmed.length >= 8 && /^[0-9a-z_-]+$/i.test(trimmed))
  );
};

export const agyBrainRoot = (home: string): string =>
  join(home, ".gemini", "antigravity-cli", "brain");

export const agyHistoryPath = (home: string): string =>
  join(home, ".gemini", "antigravity-cli", "history.jsonl");

export type AgyDiscoveryInput = {
  /** The seat's working directory. */
  readonly cwd: string;
  /** Epoch ms the seat's PTY spawned. Older sessions are excluded. */
  readonly spawnedAtMs: number;
  readonly home: string;
  /** Grace window in ms before spawnedAtMs. Default 2000. */
  readonly graceMs?: number;
  /** Session IDs known to belong to earlier/other sessions to exclude. */
  readonly exclude?: ReadonlySet<string>;
};

const DEFAULT_GRACE_MS = 2_000;

type Candidate = {
  readonly sessionId: string;
  readonly recordedAtMs: number;
  readonly workspaceRoot?: string;
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Best-effort lookup for workspace root recorded in history.jsonl. */
const readWorkspaceFromHistory = (historyPath: string, sessionId: string): string | undefined => {
  if (!existsSync(historyPath)) return undefined;
  try {
    const content = readFileSync(historyPath, "utf8");
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.conversationId === sessionId && typeof parsed.workspace === "string") {
          return parsed.workspace;
        }
      } catch {
        // ignore malformed line
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

/**
 * Discover the session ID started by this seat after spawn.
 */
export const discoverAgySessionId = (
  input: AgyDiscoveryInput,
): string | undefined => {
  const root = agyBrainRoot(input.home);
  if (!isDirectory(root)) return undefined;

  let dirEntries: string[];
  try {
    dirEntries = readdirSync(root);
  } catch {
    return undefined;
  }

  const floor = input.spawnedAtMs - (input.graceMs ?? DEFAULT_GRACE_MS);
  const historyPath = agyHistoryPath(input.home);
  const candidates: Candidate[] = [];

  for (const name of dirEntries) {
    if (!isAgySessionId(name)) continue;
    if (input.exclude?.has(name)) continue;

    const sessionDir = join(root, name);
    if (!isDirectory(sessionDir)) continue;

    let dirStat;
    try {
      dirStat = statSync(sessionDir);
    } catch {
      continue;
    }

    const transcript = join(sessionDir, ".system_generated", "logs", "transcript.jsonl");
    let transcriptStat;
    try {
      if (existsSync(transcript)) {
        transcriptStat = statSync(transcript);
      }
    } catch {
      // best-effort
    }

    const recordedAtMs = Math.max(
      dirStat.birthtimeMs || 0,
      dirStat.mtimeMs || 0,
      transcriptStat?.birthtimeMs || 0,
      transcriptStat?.mtimeMs || 0,
    );

    if (recordedAtMs < floor) continue;

    const workspaceRoot = readWorkspaceFromHistory(historyPath, name);
    if (workspaceRoot !== undefined && input.cwd) {
      const normWorkspace = workspaceRoot.replace(/\/+$/, "");
      const normCwd = input.cwd.replace(/\/+$/, "");
      if (normWorkspace !== normCwd) continue;
    }

    candidates.push({
      sessionId: name,
      recordedAtMs,
      workspaceRoot,
    });
  }

  if (candidates.length === 0) return undefined;

  // Newest session wins
  candidates.sort((a, b) => b.recordedAtMs - a.recordedAtMs);
  return candidates[0]?.sessionId;
};
