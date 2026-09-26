/**
 * Hang recorder: when the app freezes, write down where, before anyone
 * force-quits it.
 *
 * Two freezes are covered, each with the JavaScript stack at the moment:
 *
 * 1. **Main thread stalls.** Main bumps a shared heartbeat every
 *    HANG_HEARTBEAT_MS. A worker thread watches it; when it stops moving for
 *    MAIN_STALL_MS the worker connects to the main thread's inspector
 *    in-process (`Session.connectToMainThread`, no port, nothing listens),
 *    pauses it, reads the call frames, resumes and disconnects. The worker
 *    writes the record itself, because a stalled main may never write again.
 *    When the heartbeat moves again it writes how long the stall lasted.
 * 2. **Renderer hangs.** Chromium's hang monitor emits `unresponsive` when
 *    the renderer stops acking input (about 17 s on this Electron). Main
 *    reads the renderer's stack with `collectJavaScriptCallStack` (the
 *    document opts in, see @shared/renderer-document-policy) and records it,
 *    then records `responsive` with the duration, or `gone` with the reason.
 *
 * Output is `~/.junto/logs/hangs.jsonl`, owner-only, one JSON line per event,
 * rotated once to `hangs.jsonl.1` at HANG_LOG_MAX_BYTES, so the pair never
 * exceeds twice that. Records hold kinds, durations, versions and stack
 * frames (function names and file URLs); no arguments, values or content.
 * All writes happen on the worker, so recording never blocks main.
 */
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { WebContents } from "electron";
import { transportLogDirectory } from "@shared/transport-trace";

export const HANG_LOG_FILE = "hangs.jsonl";
export const HANG_LOG_MAX_BYTES = 512 * 1024;
/** Main has not turned the heartbeat for this long: a stall worth a stack. */
export const MAIN_STALL_MS = 1_500;
export const HANG_HEARTBEAT_MS = 250;
/** How long a stack read may take before the record is written without one. */
export const HANG_STACK_TIMEOUT_MS = 3_000;
export const HANG_STACK_MAX_FRAMES = 40;
export const HANG_STACK_MAX_CHARS = 8_192;

export const hangLogPath = (): string => join(transportLogDirectory(), HANG_LOG_FILE);

export type HangRecord =
  | {
      readonly kind: "main-stall";
      /** How long main had been stalled when the stack was read. */
      readonly ms: number;
      readonly stack: string | null;
      readonly stackError?: string;
    }
  | { readonly kind: "main-stall-end"; readonly ms: number }
  | { readonly kind: "renderer-unresponsive"; readonly stack: string | null; readonly stackError?: string }
  | { readonly kind: "renderer-responsive"; readonly ms: number }
  | { readonly kind: "renderer-gone"; readonly reason: string; readonly exitCode: number };

/** Keep the innermost frames of a V8 stack string, bounded in frames and size. */
export const trimStack = (stack: string): string => {
  const frames = stack
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, HANG_STACK_MAX_FRAMES)
    .join("\n");
  return frames.length > HANG_STACK_MAX_CHARS ? frames.slice(0, HANG_STACK_MAX_CHARS) : frames;
};

/**
 * The worker, as CommonJS source run with `eval: true`: no bundling, no asar
 * path, nothing to resolve at run time. It only uses Node built-ins.
 */
export const HANG_WORKER_SOURCE = String.raw`
"use strict";
const { workerData, parentPort } = require("node:worker_threads");
const { Session } = require("node:inspector");
const fs = require("node:fs");
const path = require("node:path");
const w = workerData;

let dirReady = false;
const append = (record) => {
  try {
    if (!dirReady) {
      fs.mkdirSync(path.dirname(w.logPath), { recursive: true, mode: 0o700 });
      dirReady = true;
    }
    try {
      if (fs.statSync(w.logPath).size >= w.maxBytes) fs.renameSync(w.logPath, w.logPath + ".1");
    } catch {}
    const row = Object.assign({ ts: new Date().toISOString(), pid: w.pid, version: w.version }, record);
    const fd = fs.openSync(w.logPath, "a", 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.appendFileSync(fd, JSON.stringify(row) + "\n", "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
};

parentPort.on("message", (message) => {
  if (message && message.type === "record") append(message.record);
});

// Call frames carry a scriptId; the URL comes from scriptParsed, which the
// inspector replays for every loaded script on Debugger.enable.
const formatFrames = (callFrames, urls) =>
  callFrames
    .slice(0, w.maxFrames)
    .map((f) => "    at " + (f.functionName || "<anonymous>") + " (" +
      (f.url || urls.get(f.location.scriptId) || "<unknown>") + ":" +
      (f.location.lineNumber + 1) + ":" + (f.location.columnNumber + 1) + ")")
    .join("\n")
    .slice(0, w.maxChars);

const captureMainStack = (stalledMs) => {
  const beatAtStart = Atomics.load(w.beat, 0);
  let session;
  try {
    session = new Session();
    session.connectToMainThread();
  } catch (error) {
    append({ kind: "main-stall", ms: stalledMs, stack: null, stackError: String(error && error.message) });
    return;
  }
  let done = false;
  const finish = (stack, stackError) => {
    if (done) return;
    done = true;
    // Disconnecting disables the debugger, which also drops a pause that
    // was requested but never reached (main blocked outside JavaScript).
    try { session.disconnect(); } catch {}
    append(Object.assign({ kind: "main-stall", ms: stalledMs, stack }, stackError ? { stackError } : {}));
  };
  const urls = new Map();
  session.on("Debugger.scriptParsed", (message) => {
    if (message.params.url) urls.set(message.params.scriptId, message.params.url);
  });
  session.on("Debugger.paused", (message) => {
    // The pause landed after main turned the heartbeat again: that stack is
    // whatever ran next, not what stalled. Say so instead of misleading.
    const late = Atomics.load(w.beat, 0) !== beatAtStart;
    const stack = late ? null : formatFrames(message.params.callFrames, urls);
    const lateError = late ? "the stall ended before the stack was read" : undefined;
    try {
      session.post("Debugger.resume", () => finish(stack, lateError));
    } catch {
      finish(stack, lateError);
    }
  });
  try {
    session.post("Debugger.enable", (error) => {
      if (error) return finish(null, String(error.message));
      session.post("Debugger.pause", (pauseError) => {
        if (pauseError) finish(null, String(pauseError.message));
      });
    });
  } catch (error) {
    finish(null, String(error && error.message));
  }
  setTimeout(() => finish(null, "main ran no JavaScript while stalled (native code or suspended)"), w.stackTimeoutMs);
};

let lastBeat = Atomics.load(w.beat, 0);
let lastChangeAt = Date.now();
let lastTickAt = Date.now();
let stalledSince = null;
setInterval(() => {
  const now = Date.now();
  const gap = now - lastTickAt;
  lastTickAt = now;
  const beat = Atomics.load(w.beat, 0);
  // The worker itself slept (system sleep, App Nap): not a main stall.
  if (gap > w.heartbeatMs * 4 + 1000) {
    lastBeat = beat;
    lastChangeAt = now;
    stalledSince = null;
    return;
  }
  if (beat !== lastBeat) {
    if (stalledSince !== null) append({ kind: "main-stall-end", ms: now - stalledSince });
    lastBeat = beat;
    lastChangeAt = now;
    stalledSince = null;
    return;
  }
  if (stalledSince === null && now - lastChangeAt >= w.stallMs) {
    stalledSince = lastChangeAt;
    captureMainStack(now - lastChangeAt);
  }
}, w.heartbeatMs);
`;

export type HangRecorder = {
  readonly record: (record: HangRecord) => void;
  readonly stop: () => Promise<void>;
};

export type HangRecorderOptions = {
  readonly version: string;
  readonly logPath?: string;
  readonly stallMs?: number;
  readonly heartbeatMs?: number;
  readonly stackTimeoutMs?: number;
  readonly maxBytes?: number;
};

let running: HangRecorder | undefined;

/**
 * Start the recorder once per process. Never throws: when the worker cannot
 * start, recording is a no-op and the app runs as before.
 */
export const startHangRecorder = (options: HangRecorderOptions): HangRecorder => {
  if (running) return running;
  const heartbeatMs = options.heartbeatMs ?? HANG_HEARTBEAT_MS;
  let worker: Worker | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const beat = new Int32Array(new SharedArrayBuffer(4));
    worker = new Worker(HANG_WORKER_SOURCE, {
      eval: true,
      workerData: {
        beat,
        logPath: options.logPath ?? hangLogPath(),
        maxBytes: options.maxBytes ?? HANG_LOG_MAX_BYTES,
        stallMs: options.stallMs ?? MAIN_STALL_MS,
        heartbeatMs,
        stackTimeoutMs: options.stackTimeoutMs ?? HANG_STACK_TIMEOUT_MS,
        maxFrames: HANG_STACK_MAX_FRAMES,
        maxChars: HANG_STACK_MAX_CHARS,
        version: options.version,
        pid: process.pid,
      },
    });
    worker.on("error", () => {
      // A dead recorder must never take the app with it.
    });
    worker.unref();
    heartbeat = setInterval(() => Atomics.add(beat, 0, 1), heartbeatMs);
    heartbeat.unref();
  } catch {
    worker = undefined;
  }
  const recorder: HangRecorder = {
    record: (record) => {
      try {
        worker?.postMessage({ type: "record", record });
      } catch {
        // recording is best effort
      }
    },
    stop: async () => {
      if (heartbeat) clearInterval(heartbeat);
      const current = worker;
      worker = undefined;
      if (running === recorder) running = undefined;
      await current?.terminate().catch(() => undefined);
    },
  };
  running = recorder;
  return recorder;
};

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T | "timeout"> =>
  Promise.race([
    work,
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), ms).unref();
    }),
  ]);

/** Chromium answers a document that did not opt in with this sentence. */
const NOT_OPTED_IN = /not opted in/iu;

/**
 * Record the app renderer's hangs: the stack when it goes unresponsive, how
 * long it stayed that way, and why it went away if it did.
 */
export const watchRendererHangs = (contents: WebContents, recorder: HangRecorder): void => {
  let unresponsiveAt: number | undefined;
  contents.on("unresponsive", () => {
    if (unresponsiveAt !== undefined) return;
    unresponsiveAt = Date.now();
    const frame = contents.mainFrame;
    void withTimeout(
      Promise.resolve(frame.collectJavaScriptCallStack()).catch((error: unknown) =>
        error instanceof Error ? `error: ${error.message}` : "error",
      ),
      HANG_STACK_TIMEOUT_MS,
    ).then((result) => {
      if (typeof result === "string" && result !== "timeout" && !result.startsWith("error: ") && !NOT_OPTED_IN.test(result)) {
        recorder.record({ kind: "renderer-unresponsive", stack: trimStack(result) });
        return;
      }
      recorder.record({
        kind: "renderer-unresponsive",
        stack: null,
        stackError: typeof result === "string" ? result.slice(0, 200) : "no JavaScript was running",
      });
    });
  });
  contents.on("responsive", () => {
    if (unresponsiveAt === undefined) return;
    recorder.record({ kind: "renderer-responsive", ms: Date.now() - unresponsiveAt });
    unresponsiveAt = undefined;
  });
  contents.on("render-process-gone", (_event, details) => {
    recorder.record({ kind: "renderer-gone", reason: details.reason, exitCode: details.exitCode });
    unresponsiveAt = undefined;
  });
};
