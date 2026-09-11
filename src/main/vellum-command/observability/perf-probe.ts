/**
 * Env-gated main-thread perf probe (`VELLUM_PERF=1`).
 *
 * Answers one question with measurements instead of inference: which caller
 * drives the synchronous main-thread bursts, and how big are those bursts.
 *
 * Two instruments:
 *
 * 1. **Canvas read tape** — every `CanvasesService.read` carries a caller tag.
 *    Per call we record wall duration, the number of SQLite statements the
 *    read executed, and the serialized byte size of the projected document.
 * 2. **Block monitor** — a short timer that measures its own lateness. Timer
 *    lateness is event-loop stall, which on the main process is exactly the
 *    synchronous block that makes typing lag. Any stall over the threshold is
 *    recorded together with the canvas reads that ran inside it, so a block is
 *    attributed to a caller rather than guessed at.
 *
 * Zero cost when off: the module is a live singleton only when the env flag is
 * set. Hot-path sites guard on the exported `perfProbeEnabled` constant, so a
 * disabled build pays one boolean test per SQL statement and nothing else.
 *
 * Output is one compact JSON line every 5s appended to
 * `~/.vellum-command/logs/perf.jsonl`, beside the transport tape. Install-local
 * debugging output, never product state.
 */
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { transportLogDirectory } from "@shared/transport-trace";

export const PERF_LOG_FILE = "perf.jsonl";

/** Timer period. Short enough to bracket a burst, long enough to be free. */
export const PERF_TICK_MS = 20;
/** Timer lateness at or above this is reported as a main-thread block. */
export const PERF_BLOCK_MS = 50;
/** One summary line per window. */
export const PERF_WINDOW_MS = 5_000;
/** Bound the retained tape so a long run cannot grow memory without limit. */
export const PERF_MAX_SAMPLES = 5_000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

/** One completed canvas read. */
export type PerfReadSample = {
  readonly tag: string;
  readonly ms: number;
  readonly statements: number;
  readonly bytes: number;
  /** Time spent measuring `bytes`. Probe overhead, not read cost. */
  readonly probeMs: number;
};

/** Canvas reads that completed inside one blocked interval. */
export type PerfBlockAttribution = {
  readonly tag: string;
  readonly calls: number;
  readonly ms: number;
};

/** One main-thread stall observed as timer lateness. */
export type PerfBlockSample = {
  readonly ms: number;
  readonly attribution: ReadonlyArray<PerfBlockAttribution>;
};

export type PerfCallerRollup = {
  readonly tag: string;
  readonly calls: number;
  readonly totalMs: number;
  readonly p50Ms: number;
  readonly maxMs: number;
  readonly statements: number;
  readonly bytes: number;
};

export type PerfBlockRollup = {
  readonly count: number;
  readonly perSec: number;
  readonly totalMs: number;
  readonly dutyPct: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly maxMs: number;
  /** Blocked milliseconds attributed to each caller by the reads inside them. */
  readonly byCaller: ReadonlyArray<PerfBlockAttribution>;
};

export type PerfWindowLine = {
  readonly kind: "perf.window";
  readonly ts: string;
  readonly windowMs: number;
  readonly reads: {
    readonly calls: number;
    readonly perSec: number;
    readonly totalMs: number;
    readonly probeMs: number;
    readonly byCaller: ReadonlyArray<PerfCallerRollup>;
  };
  readonly blocks: PerfBlockRollup;
  /** Set when the tape hit its bound and older samples were dropped. */
  readonly dropped?: number;
};

const round = (value: number, digits = 1): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/** Nearest-rank quantile over an ascending array. Empty array is 0. */
export const perfQuantile = (
  ascending: ReadonlyArray<number>,
  quantile: number,
): number => {
  if (ascending.length === 0) return 0;
  const rank = Math.ceil(quantile * ascending.length);
  const index = Math.min(ascending.length - 1, Math.max(0, rank - 1));
  return ascending[index] ?? 0;
};

export const summarizePerfReads = (
  samples: ReadonlyArray<PerfReadSample>,
): ReadonlyArray<PerfCallerRollup> => {
  const byTag = new Map<string, Array<PerfReadSample>>();
  for (const sample of samples) {
    const bucket = byTag.get(sample.tag);
    if (bucket === undefined) byTag.set(sample.tag, [sample]);
    else bucket.push(sample);
  }
  return [...byTag.entries()]
    .map(([tag, bucket]) => {
      const durations = bucket.map((entry) => entry.ms).sort((a, b) => a - b);
      return {
        tag,
        calls: bucket.length,
        totalMs: round(bucket.reduce((sum, entry) => sum + entry.ms, 0)),
        p50Ms: round(perfQuantile(durations, 0.5)),
        maxMs: round(durations[durations.length - 1] ?? 0),
        statements: bucket.reduce((sum, entry) => sum + entry.statements, 0),
        bytes: bucket.reduce((sum, entry) => sum + entry.bytes, 0),
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
};

export const summarizePerfBlocks = (
  samples: ReadonlyArray<PerfBlockSample>,
  windowMs: number,
): PerfBlockRollup => {
  const durations = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const totalMs = durations.reduce((sum, value) => sum + value, 0);
  const byTag = new Map<string, { calls: number; ms: number }>();
  for (const sample of samples) {
    for (const entry of sample.attribution) {
      const current = byTag.get(entry.tag) ?? { calls: 0, ms: 0 };
      byTag.set(entry.tag, {
        calls: current.calls + entry.calls,
        ms: current.ms + entry.ms,
      });
    }
  }
  return {
    count: samples.length,
    perSec: windowMs > 0 ? round((samples.length * 1000) / windowMs, 2) : 0,
    totalMs: round(totalMs),
    dutyPct: windowMs > 0 ? round((totalMs / windowMs) * 100) : 0,
    minMs: round(durations[0] ?? 0),
    p50Ms: round(perfQuantile(durations, 0.5)),
    p90Ms: round(perfQuantile(durations, 0.9)),
    maxMs: round(durations[durations.length - 1] ?? 0),
    byCaller: [...byTag.entries()]
      .map(([tag, value]) => ({ tag, calls: value.calls, ms: round(value.ms) }))
      .sort((a, b) => b.ms - a.ms),
  };
};

/** Serialized size of a decoded projection. Never throws into the read path. */
export const perfByteSize = (value: unknown): number => {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
  } catch {
    return 0;
  }
};

/** Open read. Held by the caller for the duration of one canvas read. */
export type PerfReadToken = {
  readonly tag: string;
  readonly startedAt: number;
  readonly statementsAt: number;
};

export type PerfProbe = {
  /** One SQLite statement executed on the main thread. */
  readonly countStatement: () => void;
  readonly beginRead: (tag: string) => PerfReadToken;
  readonly endRead: (token: PerfReadToken, projection: unknown) => void;
  /** Record an observed stall. Exposed for tests; the timer calls it live. */
  readonly recordBlock: (ms: number) => void;
  /** Roll up and clear the tape. */
  readonly drain: (windowMs?: number) => PerfWindowLine;
  readonly start: () => void;
  readonly stop: () => void;
};

export type PerfProbeOptions = {
  readonly now?: () => number;
  readonly emit?: (line: PerfWindowLine) => void;
  readonly tickMs?: number;
  readonly blockMs?: number;
  readonly windowMs?: number;
  readonly maxSamples?: number;
};

export const makePerfProbe = (options: PerfProbeOptions = {}): PerfProbe => {
  const now = options.now ?? (() => performance.now());
  const emit = options.emit ?? appendPerfLine;
  const tickMs = options.tickMs ?? PERF_TICK_MS;
  const blockMs = options.blockMs ?? PERF_BLOCK_MS;
  const windowMs = options.windowMs ?? PERF_WINDOW_MS;
  const maxSamples = options.maxSamples ?? PERF_MAX_SAMPLES;

  let statements = 0;
  let reads: Array<PerfReadSample> = [];
  let blocks: Array<PerfBlockSample> = [];
  let dropped = 0;
  // Reads completed since the last timer tick. A stall observed on the next
  // tick names these as the work that ran inside it.
  let sinceTick = new Map<string, { calls: number; ms: number }>();
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let windowTimer: ReturnType<typeof setInterval> | undefined;
  let lastTickAt = 0;

  const push = <A>(tape: Array<A>, sample: A): void => {
    if (tape.length >= maxSamples) {
      tape.shift();
      dropped += 1;
    }
    tape.push(sample);
  };

  const countStatement = (): void => {
    statements += 1;
  };

  const beginRead = (tag: string): PerfReadToken => ({
    tag,
    startedAt: now(),
    statementsAt: statements,
  });

  const endRead = (token: PerfReadToken, projection: unknown): void => {
    const endedAt = now();
    const ms = endedAt - token.startedAt;
    // Byte measurement is expensive on a 1MB+ projection. Time it separately
    // so the reported read duration stays the real read duration.
    const bytes = perfByteSize(projection);
    const probeMs = now() - endedAt;
    push(reads, {
      tag: token.tag,
      ms,
      statements: statements - token.statementsAt,
      bytes,
      probeMs,
    });
    const current = sinceTick.get(token.tag) ?? { calls: 0, ms: 0 };
    sinceTick.set(token.tag, { calls: current.calls + 1, ms: current.ms + ms });
  };

  const recordBlock = (ms: number): void => {
    push(blocks, {
      ms,
      attribution: [...sinceTick.entries()].map(([tag, value]) => ({
        tag,
        calls: value.calls,
        ms: round(value.ms),
      })),
    });
  };

  const tick = (): void => {
    const at = now();
    const late = at - lastTickAt - tickMs;
    lastTickAt = at;
    if (late >= blockMs) recordBlock(late);
    if (sinceTick.size > 0) sinceTick = new Map();
  };

  const drain = (observedWindowMs = windowMs): PerfWindowLine => {
    const readSamples = reads;
    const blockSamples = blocks;
    const droppedCount = dropped;
    reads = [];
    blocks = [];
    dropped = 0;
    return {
      kind: "perf.window",
      ts: new Date().toISOString(),
      windowMs: observedWindowMs,
      reads: {
        calls: readSamples.length,
        perSec:
          observedWindowMs > 0
            ? round((readSamples.length * 1000) / observedWindowMs, 2)
            : 0,
        totalMs: round(readSamples.reduce((sum, entry) => sum + entry.ms, 0)),
        probeMs: round(
          readSamples.reduce((sum, entry) => sum + entry.probeMs, 0),
        ),
        byCaller: summarizePerfReads(readSamples),
      },
      blocks: summarizePerfBlocks(blockSamples, observedWindowMs),
      ...(droppedCount > 0 ? { dropped: droppedCount } : {}),
    };
  };

  const start = (): void => {
    if (tickTimer !== undefined) return;
    lastTickAt = now();
    tickTimer = setInterval(tick, tickMs);
    tickTimer.unref?.();
    windowTimer = setInterval(() => {
      emit(drain());
    }, windowMs);
    windowTimer.unref?.();
  };

  const stop = (): void => {
    if (tickTimer !== undefined) clearInterval(tickTimer);
    if (windowTimer !== undefined) clearInterval(windowTimer);
    tickTimer = undefined;
    windowTimer = undefined;
  };

  return { countStatement, beginRead, endRead, recordBlock, drain, start, stop };
};

export const perfLogPath = (): string =>
  join(transportLogDirectory(), PERF_LOG_FILE);

let logDirectoryReady = false;

const preparePerfDirectory = (): void => {
  const directory = transportLogDirectory();
  mkdirSync(directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
  chmodSync(dirname(directory), OWNER_DIRECTORY_MODE);
  chmodSync(directory, OWNER_DIRECTORY_MODE);
};

const rotatePerfLogIfNeeded = (): void => {
  try {
    const path = perfLogPath();
    if (statSync(path).size < MAX_LOG_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    // Missing or unrotatable. The next append still tries.
  }
};

/** Append one window line. A log miss must never break the app. */
export const appendPerfLine = (line: PerfWindowLine): void => {
  try {
    if (!logDirectoryReady) {
      preparePerfDirectory();
      logDirectoryReady = true;
    }
    rotatePerfLogIfNeeded();
    appendFileSync(perfLogPath(), `${JSON.stringify(line)}\n`, {
      encoding: "utf8",
      mode: OWNER_FILE_MODE,
    });
  } catch {
    // Instrumentation never takes down the process it measures.
  }
};

/**
 * Single env gate. Read once at module load so every hot-path guard is a
 * constant boolean test that the JIT can fold away when the probe is off.
 */
export const perfProbeEnabled = process.env.VELLUM_PERF === "1";

/** Live probe, or `undefined` when the env gate is off. */
export const perfProbe: PerfProbe | undefined = perfProbeEnabled
  ? makePerfProbe()
  : undefined;

export const startPerfProbe = (): void => {
  perfProbe?.start();
};
