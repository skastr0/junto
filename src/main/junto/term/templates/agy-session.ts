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
import {
  discoverSpawnedSession,
  isUuid,
  type SpawnedSessionCandidate,
  type SpawnedSessionInput,
  type SpawnedSessionStore,
} from "./spawned-session";

const CONV_SLUG = /^conv-[0-9a-z_-]+$/i;

/** Validate whether a string is a valid agy conversation/session ID. */
export const isAgySessionId = (value: string): boolean => {
  const trimmed = value.trim();
  return (
    isUuid(trimmed) ||
    CONV_SLUG.test(trimmed) ||
    (trimmed.length >= 8 && /^[0-9a-z_-]+$/i.test(trimmed))
  );
};

export const agyBrainRoot = (home: string): string =>
  join(home, ".gemini", "antigravity-cli", "brain");

export const agyHistoryPath = (home: string): string =>
  join(home, ".gemini", "antigravity-cli", "history.jsonl");

export type AgyDiscoveryInput = SpawnedSessionInput;

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
 * Antigravity's store: every brain directory touched since the floor, the
 * latest of its own and its transcript's times. The workspace is checked
 * where history.jsonl recorded one; the newest session wins.
 */
export const AGY_SPAWNED_SESSIONS: SpawnedSessionStore = {
  isSessionId: isAgySessionId,
  sameWorkspace: "trimmed",
  pick: "newest",
  scan: ({ home, floorMs }) => {
    const root = agyBrainRoot(home);
    if (!isDirectory(root)) return { candidates: [], workspace: "ifRecorded" };
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return { candidates: [], workspace: "ifRecorded" };
    }
    const historyPath = agyHistoryPath(home);
    const candidates: SpawnedSessionCandidate[] = [];
    for (const name of names) {
      if (!isAgySessionId(name)) continue;
      const sessionDir = join(root, name);
      let dirStat;
      try {
        dirStat = statSync(sessionDir);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;
      const transcript = join(sessionDir, ".system_generated", "logs", "transcript.jsonl");
      let transcriptStat;
      try {
        if (existsSync(transcript)) transcriptStat = statSync(transcript);
      } catch {
        // best-effort
      }
      const startedAtMs = Math.max(
        dirStat.birthtimeMs || 0,
        dirStat.mtimeMs || 0,
        transcriptStat?.birthtimeMs || 0,
        transcriptStat?.mtimeMs || 0,
      );
      // The history read is the expensive part; a session too old to be this
      // seat's never needs it.
      if (startedAtMs < floorMs) continue;
      const workspace = readWorkspaceFromHistory(historyPath, name);
      candidates.push({ id: name, startedAtMs, ...(workspace === undefined ? {} : { workspace }) });
    }
    return { candidates, workspace: "ifRecorded" };
  },
};

/** Discover the session ID started by this seat after spawn. */
export const discoverAgySessionId = (input: AgyDiscoveryInput): string | undefined =>
  discoverSpawnedSession(AGY_SPAWNED_SESSIONS, input);
