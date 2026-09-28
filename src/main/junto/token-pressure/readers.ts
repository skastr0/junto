/**
 * Per-harness context readers: where a seat's session file lives, and which
 * line in it says how full the context is. Minimal on purpose. Each reader
 * trusts only a record the harness itself writes after every model call, and
 * a harness without such a record has no reader here at all.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  claudeContextWindow,
  type ContextReading,
} from "@shared/token-pressure";
import { encodeClaudeProjectCwd } from "../term/session-existence";

export type SeatSessionRef = {
  readonly harness: string;
  readonly sessionId: string;
  readonly cwd?: string;
  /** The model the seat was launched with, when its launch names one. */
  readonly launchModel?: string;
  /** The seat's launch env, for harness home overrides. */
  readonly env?: Readonly<Record<string, string>>;
};

export type ContextReader = {
  /** The session file for this seat, or undefined while there is none. */
  readonly locate: (seat: SeatSessionRef, home: string) => string | undefined;
  readonly parseLine: (line: string, seat: SeatSessionRef) => ContextReading | undefined;
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

const timeOf = (value: unknown): number => {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : Date.now();
};

const parseJson = (line: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

// ── Claude Code ─────────────────────────────────────────────────────────────

const claudeRoot = (seat: SeatSessionRef, home: string): string =>
  seat.env?.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");

/**
 * `<config>/projects/<cwd with / as ->/<session>.jsonl`. The cwd dir is the
 * one place to look; a seat whose folder moved is found by one scan.
 */
const locateClaude = (seat: SeatSessionRef, home: string): string | undefined => {
  const projects = join(claudeRoot(seat, home), "projects");
  const name = `${seat.sessionId}.jsonl`;
  if (seat.cwd?.trim()) {
    const direct = join(projects, encodeClaudeProjectCwd(seat.cwd), name);
    if (isFile(direct)) return direct;
  }
  if (!existsSync(projects)) return undefined;
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, name);
      if (isFile(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

/**
 * The last main-thread assistant record's `message.usage`. What the model
 * saw as context is input + cache read + cache creation. Subagent records
 * (`isSidechain`) and synthetic records carry no main-context usage.
 */
const parseClaude = (line: string, seat: SeatSessionRef): ContextReading | undefined => {
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return undefined;
  const row = parseJson(line);
  if (row === undefined || row.type !== "assistant" || row.isSidechain === true) return undefined;
  const message = record(row.message);
  const usage = record(message?.usage);
  if (usage === undefined) return undefined;
  const model = typeof message?.model === "string" ? message.model : undefined;
  if (model === "<synthetic>") return undefined;
  const usedTokens =
    count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
  if (usedTokens === 0) return undefined;
  return {
    usedTokens,
    window: claudeContextWindow(seat.launchModel),
    windowSource: "table",
    ...(model !== undefined ? { model } : {}),
    at: timeOf(row.timestamp),
  };
};

// ── Codex ───────────────────────────────────────────────────────────────────

const codexRoot = (seat: SeatSessionRef, home: string): string =>
  seat.env?.CODEX_HOME?.trim() || join(home, ".codex");

/** A UUIDv7 thread id carries its creation time in its first 48 bits. */
const uuidV7Time = (id: string): number | undefined => {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return undefined;
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  return Number.isFinite(ms) ? ms : undefined;
};

const dayDirs = (root: string, ms: number): string[] => {
  const out: string[] = [];
  // Rollouts file under the local date; a day either side covers any zone.
  for (const offset of [0, -1, 1]) {
    const day = new Date(ms + offset * 86_400_000);
    const y = String(day.getFullYear());
    const m = String(day.getMonth() + 1).padStart(2, "0");
    const d = String(day.getDate()).padStart(2, "0");
    out.push(join(root, y, m, d));
  }
  return out;
};

const findRollout = (dir: string, sessionId: string): string | undefined => {
  try {
    const hit = readdirSync(dir).find(
      (name) => name.startsWith("rollout-") && name.endsWith(".jsonl") && name.includes(sessionId),
    );
    return hit === undefined ? undefined : join(dir, hit);
  } catch {
    return undefined;
  }
};

const walkForRollout = (dir: string, sessionId: string, depth: number): string | undefined => {
  if (depth > 4) return undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (name.startsWith("rollout-") && name.endsWith(".jsonl") && name.includes(sessionId)) return join(dir, name);
  }
  for (const name of names) {
    const child = join(dir, name);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    const hit = walkForRollout(child, sessionId, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

/** `<codex home>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`. */
const locateCodex = (seat: SeatSessionRef, home: string): string | undefined => {
  const root = join(codexRoot(seat, home), "sessions");
  const born = uuidV7Time(seat.sessionId);
  if (born !== undefined) {
    for (const dir of dayDirs(root, born)) {
      const hit = findRollout(dir, seat.sessionId);
      if (hit !== undefined) return hit;
    }
  }
  return walkForRollout(root, seat.sessionId, 0);
};

/**
 * `event_msg` / `token_count`: `info.last_token_usage.input_tokens` is the
 * prompt the model just saw (cached tokens included), and
 * `info.model_context_window` is the exact window. `info` is null before the
 * first model call.
 */
const parseCodex = (line: string): ContextReading | undefined => {
  if (!line.includes('"token_count"')) return undefined;
  const row = parseJson(line);
  const payload = record(row?.payload);
  if (row?.type !== "event_msg" || payload?.type !== "token_count") return undefined;
  const info = record(payload.info);
  const last = record(info?.last_token_usage);
  if (last === undefined) return undefined;
  const usedTokens = count(last.input_tokens);
  if (usedTokens === 0) return undefined;
  const window = count(info?.model_context_window);
  return {
    usedTokens,
    ...(window > 0 ? { window, windowSource: "session" as const } : {}),
    at: timeOf(row.timestamp),
  };
};

// ── Registry ────────────────────────────────────────────────────────────────

export const CONTEXT_READERS: Readonly<Record<string, ContextReader>> = {
  claude: { locate: locateClaude, parseLine: parseClaude },
  codex: { locate: locateCodex, parseLine: (line) => parseCodex(line) },
};

export const contextReaderFor = (harness: string): ContextReader | undefined =>
  Object.hasOwn(CONTEXT_READERS, harness) ? CONTEXT_READERS[harness] : undefined;
