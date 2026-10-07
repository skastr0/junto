/**
 * How big a session is, as tokens: the number the automatic offboard rules
 * compare to their threshold.
 *
 * Two bases, and the answer says which:
 *
 * - `recorded`: the harness wrote its own token counts into the transcript,
 *   and `tokens` is the context size of its latest model call (input, cache
 *   and output). That is what an uncached wake actually re-sends. It already
 *   reflects a harness that compacted its own context.
 * - `estimated`: `tokens` is the transcript's bytes over a stated constant
 *   for that format (`SESSION_SIZE_BYTES_PER_TOKEN`). It OVERCOUNTS a session
 *   whose harness compacted its own context: the file keeps everything the
 *   model no longer sees. It is also the fallback when a recorded format's
 *   last usage record sits further back than the tail that is read.
 *
 * Undefined means there is nothing honest to say: the transcript cannot be
 * located, or what was located is not the conversation (Cursor's blob store,
 * fx's event log). The caller then judges the session without a size.
 *
 * Cheap and synchronous: one stat and a bounded read of the END of the file
 * (never the whole transcript), or one read-only query for the two harnesses
 * whose only record is their own database. Never throws.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  harnessSessionLocation,
  type SessionExistenceProbe,
} from "./session-existence";

export type SessionSize = {
  readonly tokens: number;
  /** The file the size was read from. */
  readonly transcriptPath: string;
  readonly basis: "recorded" | "estimated";
};

/** How much of the end of a transcript is read to find its last usage record. */
export const SESSION_SIZE_TAIL_BYTES = 768 * 1024;

/**
 * Transcript bytes per context token, per harness, for the `estimated` basis.
 *
 * A transcript is JSON: keys, escapes and metadata ride every line, so it is
 * well above the ~4 bytes of plain English per token. The figures for the
 * formats that also record usage are the median of bytes over recorded
 * context across uncompacted sessions on a development machine (2026-10);
 * the others take the middle of that range. They are estimates, and the
 * settings page should say so.
 */
export const SESSION_SIZE_BYTES_PER_TOKEN: Readonly<Record<string, number>> = {
  claude: 8,
  codex: 5,
  pi: 5,
  "prime-agent": 5,
  omp: 5,
  kimi: 5,
  muse: 13,
  // No calibration possible: the middle of the measured range.
  grok: 6,
  amp: 6,
  agy: 6,
  // Message text read out of the harness's own database, without the JSON
  // wrapping a transcript file carries.
  hermes: 4,
  devin: 6,
};

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const at = (value: unknown, ...path: string[]): unknown => {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
};
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** One transcript record's context size, or undefined when it records none. */
type UsageReader = (record: Json) => number | undefined;

const positive = (total: number): number | undefined => (total > 0 ? total : undefined);

const claudeUsage: UsageReader = (record) => {
  // A sub-agent's turn is its own context, not the seat's.
  if (record.type !== "assistant" || record.isSidechain === true) return undefined;
  const usage = at(record, "message", "usage");
  if (!isRecord(usage)) return undefined;
  return positive(
    count(usage.input_tokens) +
      count(usage.cache_read_input_tokens) +
      count(usage.cache_creation_input_tokens) +
      count(usage.output_tokens),
  );
};

/** Codex counts cached input inside input, so the last call's total is the context. */
const codexUsage: UsageReader = (record) =>
  positive(count(at(record, "payload", "info", "last_token_usage", "total_tokens")));

/** Pi, Prime Agent and Oh My Pi share one message shape. */
const piUsage: UsageReader = (record) =>
  positive(count(at(record, "message", "usage", "totalTokens")));

const kimiUsage: UsageReader = (record) => {
  const usage = at(record, "event", "usage");
  if (!isRecord(usage)) return undefined;
  return positive(
    count(usage.inputOther) +
      count(usage.inputCacheRead) +
      count(usage.inputCacheCreation) +
      count(usage.output),
  );
};

/** Muse is a Codex fork: cached input is counted inside input. */
const museUsage: UsageReader = (record) => {
  const usage = at(record, "payload", "event", "usage");
  if (!isRecord(usage)) return undefined;
  return positive(count(usage.input_tokens) + count(usage.output_tokens));
};

const grokUsage: UsageReader = (record) =>
  positive(count(at(record, "params", "_meta", "totalTokens")));

/** The end of a file, as text. Undefined when it cannot be read. */
const readTail = (path: string, size: number): string | undefined => {
  let fd: number | undefined;
  try {
    const length = Math.min(size, SESSION_SIZE_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
};

/** The last usage record in the tail of a JSONL transcript. */
const lastRecordedUsage = (
  path: string,
  size: number,
  reader: UsageReader,
): number | undefined => {
  const tail = readTail(path, size);
  if (tail === undefined) return undefined;
  const rows = tail.split("\n");
  // The first row is cut mid-record unless the whole file fit in the tail.
  const first = size > SESSION_SIZE_TAIL_BYTES ? 1 : 0;
  for (let index = rows.length - 1; index >= first; index -= 1) {
    const row = rows[index]!.trim();
    if (row.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(row);
      const tokens = isRecord(parsed) ? reader(parsed) : undefined;
      if (tokens !== undefined) return tokens;
    } catch {
      // Not a record: keep looking.
    }
  }
  return undefined;
};

/**
 * Amp keeps a thread as one JSON document, so there are no lines to walk. The
 * last usage in the tail is found by its own field names.
 */
const ampRecordedUsage = (path: string, size: number): number | undefined => {
  const tail = readTail(path, size);
  if (tail === undefined) return undefined;
  const inputs = [...tail.matchAll(/"totalInputTokens"\s*:\s*(\d+)/g)];
  const last = inputs[inputs.length - 1];
  if (last === undefined || last.index === undefined) return undefined;
  // The output count is another field of the same flat usage object: the
  // text between the brace that opens it and the brace that closes it.
  const open = tail.lastIndexOf("{", last.index);
  const close = tail.indexOf("}", last.index);
  const usage = tail.slice(Math.max(0, open), close < 0 ? tail.length : close);
  const output = usage.match(/"outputTokens"\s*:\s*(\d+)/);
  return positive(Number(last[1]) + (output ? Number(output[1]) : 0));
};

const fileSize = (path: string): number | undefined => {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
};

/** Which file inside a located session is the conversation itself. */
const TRANSCRIPT_INSIDE: Readonly<Record<string, readonly string[]>> = {
  grok: ["chat_history.jsonl"],
  kimi: ["agents", "main", "wire.jsonl"],
  muse: ["session.jsonl"],
  fx: ["events.jsonl"],
  cursor: ["store.db"],
};

/**
 * The transcript file of a session: the conversation itself, where the
 * existing locator may answer with the session's folder. Undefined when the
 * session cannot be located or keeps no transcript file there.
 */
export const sessionTranscriptOf = (
  probe: SessionExistenceProbe,
): string | undefined => {
  try {
    const location = harnessSessionLocation(probe);
    if (location === undefined) return undefined;
    const inside = TRANSCRIPT_INSIDE[probe.harness.trim()];
    const path = inside === undefined ? location : join(location, ...inside);
    return fileSize(path) === undefined ? undefined : path;
  } catch {
    return undefined;
  }
};

const USAGE_READERS: Readonly<Record<string, UsageReader>> = {
  claude: claudeUsage,
  codex: codexUsage,
  pi: piUsage,
  "prime-agent": piUsage,
  omp: piUsage,
  kimi: kimiUsage,
  muse: museUsage,
};

/** Bytes of one session's text inside a harness's own database, read-only. */
const databaseBytes = (
  path: string,
  sql: string,
  sessionId: string,
): number | undefined => {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      open: true,
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: 2_000,
    });
    const row = database.prepare(sql).get(sessionId) as { bytes?: unknown } | undefined;
    return typeof row?.bytes === "number" && row.bytes > 0 ? row.bytes : undefined;
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
 * Hermes: only messages still in the model's context (`active`), so its own
 * compaction is respected. Tried with and without that column, since the
 * schema is the harness's to change.
 */
const HERMES_BYTES_SQL = [
  "SELECT SUM(LENGTH(COALESCE(content,'')) + LENGTH(COALESCE(tool_calls,'')) + LENGTH(COALESCE(reasoning,''))) AS bytes FROM messages WHERE session_id = ? AND COALESCE(active, 1) = 1",
  "SELECT SUM(LENGTH(COALESCE(content,''))) AS bytes FROM messages WHERE session_id = ?",
] as const;

const DEVIN_BYTES_SQL =
  "SELECT SUM(LENGTH(COALESCE(chat_message,''))) AS bytes FROM message_nodes WHERE session_id = ?";

const estimated = (
  harness: string,
  bytes: number,
  transcriptPath: string,
): SessionSize | undefined => {
  const ratio = SESSION_SIZE_BYTES_PER_TOKEN[harness];
  if (ratio === undefined || bytes <= 0) return undefined;
  return { tokens: Math.round(bytes / ratio), transcriptPath, basis: "estimated" };
};

export const sessionSizeOf = (
  probe: SessionExistenceProbe,
): SessionSize | undefined => {
  try {
    const harness = probe.harness.trim();
    const sessionId = probe.sessionId.trim();
    if (!harness || !sessionId) return undefined;
    // Not the conversation: a content-addressed blob store and an event log
    // that repeats every streamed chunk. Dividing their bytes would be a
    // guess, and a large one.
    if (harness === "cursor" || harness === "fx") return undefined;

    const location = harnessSessionLocation(probe);
    if (location === undefined) return undefined;

    if (harness === "hermes" || (harness === "devin" && location.endsWith(".db"))) {
      const statements = harness === "hermes" ? HERMES_BYTES_SQL : [DEVIN_BYTES_SQL];
      for (const sql of statements) {
        const bytes = databaseBytes(location, sql, sessionId);
        if (bytes !== undefined) return estimated(harness, bytes, location);
      }
      return undefined;
    }

    const transcriptPath = sessionTranscriptOf(probe);
    if (transcriptPath === undefined) return undefined;
    const size = fileSize(transcriptPath);
    if (size === undefined || size === 0) return undefined;

    let recorded: number | undefined;
    if (harness === "grok") {
      // Grok reports its running total beside each update, in a sibling file.
      const updates = join(location, "updates.jsonl");
      const updatesSize = fileSize(updates);
      recorded =
        updatesSize === undefined || updatesSize === 0
          ? undefined
          : lastRecordedUsage(updates, updatesSize, grokUsage);
    } else if (harness === "amp") {
      recorded = ampRecordedUsage(transcriptPath, size);
    } else {
      const reader = USAGE_READERS[harness];
      recorded = reader === undefined ? undefined : lastRecordedUsage(transcriptPath, size, reader);
    }
    if (recorded !== undefined) {
      return { tokens: recorded, transcriptPath, basis: "recorded" };
    }
    return estimated(harness, size, transcriptPath);
  } catch {
    return undefined;
  }
};
