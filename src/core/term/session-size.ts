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
import { join } from "node:path";
import { withReadOnlyDatabase } from "./read-only-sqlite";
import {
  HARNESS_SESSION_STORES,
  harnessSessionLocation,
  sessionStoreFor,
  type SessionExistenceProbe,
  type SessionSizeSpec,
} from "./session-existence";
import { lastJsonlUsage } from "./session-usage";

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
 * A transcript is JSON: keys, escapes and metadata ride every line, so it is
 * well above the ~4 bytes of plain English per token. Declared on each
 * harness's session store.
 */
export const SESSION_SIZE_BYTES_PER_TOKEN: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(HARNESS_SESSION_STORES).flatMap(([harness, store]) =>
    store?.size ? [[harness, store.size.bytesPerToken]] : [],
  ),
);

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

const fileSize = (path: string): number | undefined => {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
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
    const inside = sessionStoreFor(probe.harness.trim())?.transcriptInside;
    const path = inside === undefined ? location : join(location, ...inside);
    return fileSize(path) === undefined ? undefined : path;
  } catch {
    return undefined;
  }
};

/** Bytes of one session's text inside a harness's own database: the first statement that counts any. */
const databaseBytes = (
  path: string,
  statements: readonly string[],
  sessionId: string,
): number | undefined =>
  withReadOnlyDatabase(path, (database) => {
    for (const sql of statements) {
      try {
        const row = database.prepare(sql).get(sessionId) as { bytes?: unknown } | undefined;
        if (typeof row?.bytes === "number" && row.bytes > 0) return row.bytes;
      } catch {
        // try the next statement
      }
    }
    return undefined;
  });

export const sessionSizeOf = (
  probe: SessionExistenceProbe,
): SessionSize | undefined => {
  try {
    const harness = probe.harness.trim();
    const sessionId = probe.sessionId.trim();
    if (!harness || !sessionId) return undefined;
    // A store with no size locates something that is not the conversation:
    // a content-addressed blob store, an event log that repeats every
    // streamed chunk. Dividing their bytes would be a guess, and a large one.
    const spec = sessionStoreFor(harness)?.size;
    if (spec === undefined) return undefined;
    const estimated = (bytes: number, transcriptPath: string): SessionSize | undefined =>
      bytes > 0
        ? { tokens: Math.round(bytes / spec.bytesPerToken), transcriptPath, basis: "estimated" }
        : undefined;

    const location = harnessSessionLocation(probe);
    if (location === undefined) return undefined;

    if (spec.database && location.endsWith(".db")) {
      const bytes = databaseBytes(location, spec.database, sessionId);
      return bytes === undefined ? undefined : estimated(bytes, location);
    }

    const transcriptPath = sessionTranscriptOf(probe);
    if (transcriptPath === undefined) return undefined;
    const size = fileSize(transcriptPath);
    if (size === undefined || size === 0) return undefined;

    const recorded = recordedUsage(spec, location, transcriptPath, size);
    if (recorded !== undefined) {
      return { tokens: recorded, transcriptPath, basis: "recorded" };
    }
    return estimated(size, transcriptPath);
  } catch {
    return undefined;
  }
};

/** The harness's own count of its latest model call, from the tail of the file it writes it to. */
const recordedUsage = (
  spec: SessionSizeSpec,
  location: string,
  transcriptPath: string,
  transcriptSize: number,
): number | undefined => {
  const usage = spec.usage;
  if (usage === undefined) return undefined;
  const path = usage.kind === "jsonl" && usage.sibling ? join(location, usage.sibling) : transcriptPath;
  const size = path === transcriptPath ? transcriptSize : fileSize(path);
  if (size === undefined || size === 0) return undefined;
  const tail = readTail(path, size);
  if (tail === undefined) return undefined;
  return usage.kind === "jsonl"
    ? lastJsonlUsage(tail, size > SESSION_SIZE_TAIL_BYTES, usage.read)
    : usage.read(tail);
};
