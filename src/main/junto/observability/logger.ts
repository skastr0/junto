import { Context, Layer, Logger, References, Schema, type LogLevel } from "effect";
import type { ObservabilityLogLevel, ObservabilityLogSource } from "@shared/observability";
import { OBSERVABILITY_LEVEL_RANK } from "@shared/observability";
import {
  LOG_ROW_MAX_BYTES,
  LogCanvasName,
  LogSeatId,
  failureDetailSeat,
  isLogIdAnnotation,
  LOG_ID_ANNOTATIONS,
  type LogProcess,
  type MachineLogRow,
} from "@shared/machine-log";
import { EncodedFailure } from "@shared/failure";
import { defaultMachineName } from "@shared/machine-name";
import type { ObservabilityAppendInput } from "./ring";
import { redactSecretValues } from "../credentials/redact";
import { knownSecretValues, scrubMessage } from "../credentials/scrub";
import { decodeEncodedFailure, encodeFailure } from "../failure-encode";
import { openMachineLogSink, type MachineLogSink } from "./log-file";

/**
 * The one log path. Effect logs, `console.*` in main, renderer console lines
 * and system notes all become one row here: scrubbed once
 * (docs/security-doctrine.md, Failures and logs), then appended to the row
 * sink its boot gave it (the core's ring, or main's forwarder), to this
 * machine's log file when one is open, and to stdout when it echoes.
 *
 * The log is a value, created by the process boot that logs and handed to its
 * readers: a module-level row sink made the behaviour depend on whether the
 * boot had run. Main builds one (`observability/ipc.ts`), the core builds one
 * (`observability/logger.ts`'s callers in `junto/core.ts`, `core-process/entry.ts`
 * and `headless.ts`), and each test builds the log it exercises.
 *
 * Row fields and the list each belongs to: time, level, machine, process,
 * source, area, operationId, seat, canvas and span names are names, tags and
 * ids; message, annotation values and every message in `failure` are scrubbed
 * text; `failure` tags are tags.
 */

const levelFromEffect = (level: LogLevel.LogLevel): ObservabilityLogLevel => {
  switch (level) {
    case "Trace":
      return "trace";
    case "Debug":
      return "debug";
    case "Info":
      return "info";
    case "Warn":
      return "warn";
    case "Error":
      return "error";
    case "Fatal":
      return "fatal";
    case "All":
    case "None":
      return "info";
  }
};

/** Rows below this level stay in the ring and never reach the file. */
const FILE_MIN_LEVEL: ObservabilityLogLevel = "info";
const AREA = /^[a-z0-9][a-z0-9._-]{0,47}$/u;
const OPERATION_ID = /^[A-Za-z0-9._-]{1,64}$/u;
const CONSOLE_PREFIX = /^\[([A-Za-z0-9][A-Za-z0-9._-]{0,47})\]/u;
const MAX_ANNOTATIONS = 16;
const isLogSeatId = Schema.is(LogSeatId);
const isLogCanvasName = Schema.is(LogCanvasName);
const isEncodedFailure = Schema.is(EncodedFailure);

const DEFAULT_AREA: Record<ObservabilityLogSource, string> = {
  effect: "effect",
  main: "main",
  renderer: "renderer",
  system: "system",
};

/** Where a row goes besides the file and stdout: the core's ring, or main's forwarder. */
export type LogSink = (input: ObservabilityAppendInput) => void;

export type LogOptions = {
  /** The rows' destination. Main forwards to the core (`observability/ipc.ts`); the core appends to its ring. */
  readonly sink?: LogSink;
  /** The machine name rows carry, until the machine repository's configured name is read. */
  readonly machine?: string;
  readonly process: LogProcess;
  /** Also print each row to stdout. A windowless core does not: its stdout is an unbounded service file. */
  readonly echo: boolean;
  /** Values this process must never let into a row: the core's registry. Main holds none. */
  readonly knownSecrets?: () => ReadonlyArray<string>;
};

export type MachineLogInstall = {
  readonly home: string;
};

export type LogInput = {
  readonly level: ObservabilityLogLevel;
  readonly source: ObservabilityLogSource;
  readonly message: string;
  /**
   * A Cause, an Error or any thrown value, encoded here; or a failure already
   * encoded (one received from another machine), decoded closed and scrubbed
   * again. Never stored raw.
   */
  readonly failure?: unknown;
  /** The channel's own closed failure, for `EncodedFailure.detail`. */
  readonly detail?: unknown;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly spans?: ReadonlyArray<string>;
  readonly ts?: number;
  readonly fiber?: string;
};

export type RendererConsoleInput = {
  readonly level: "debug" | "info" | "warning" | "error";
  readonly message: string;
  readonly sourceId?: string;
  readonly lineNumber?: number;
};

export interface Log {
  /** Build one scrubbed row and send it to every sink. Returns the row. */
  readonly writeLog: (input: LogInput) => MachineLogRow;
  /** The machine name rows carry. */
  readonly machine: () => string;
  /** The machine's configured name, once the machine repository has it. */
  readonly setMachine: (name: string) => void;
  /** Open this process's log file. Idempotent per log; a second open replaces the first. */
  readonly openFile: (install: MachineLogInstall) => void;
  readonly closeFile: () => void;
  /** Stop forwarding rows (main, once quit begins); the file and stdout still take them. */
  readonly stopRows: () => void;
  /** Route `console.*` through the row path. Process-wide and idempotent: the first log to install owns it. */
  readonly installConsoleHook: (options?: { readonly echo?: boolean }) => void;
  /** Feed a renderer console-message event into the log. */
  readonly recordRendererConsole: (input: RendererConsoleInput) => void;
  readonly recordSystemLog: (message: string, level?: ObservabilityLogLevel) => void;
  /** The Effect logger and its layer, for a runtime this log writes through. */
  readonly effectLogger: Logger.Logger<unknown, void>;
  /** The Effect side of this log: the machine logger and `LogService`, which effects read by tag. */
  readonly loggerLayer: Layer.Layer<LogService>;
  readonly withLogger: <A, E, R>(layer: Layer.Layer<A, E, R>) => Layer.Layer<A | LogService, E, Exclude<R, LogService>>;
}

/**
 * The log as an Effect service, for the services built inside a runtime that
 * provides this log's layer (`core-runtime.ts`). A value, not a slot: the
 * runtime the effect runs on decides which log it reads.
 */
export class LogService extends Context.Service<LogService, Log>()("@junto/Log") {}

const annotationText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
};

/**
 * Bound raw text before it is scrubbed: the scrub's cost grows with the square
 * of a long run, and a row keeps at most 1 KiB anyway. The trailing word is
 * dropped whole so a cut never leaves half a credential for the scrub to miss.
 */
const PRECUT_CHARS = 1_536;
const precut = (text: string, known: ReadonlyArray<string | undefined>): string => {
  if (text.length <= PRECUT_CHARS) return text;
  // Known values first, over the whole text: a passphrase holds spaces, so a
  // cut at a word edge could otherwise split it. Replacement is linear.
  const redacted = redactSecretValues(text, known.filter((value): value is string => value !== undefined));
  return redacted.length <= PRECUT_CHARS ? redacted : `${redacted.slice(0, PRECUT_CHARS).replace(/\S*$/u, "")} [cut]`;
};

const fitRow = (row: MachineLogRow): string => {
  let line = JSON.stringify(row);
  if (Buffer.byteLength(line, "utf8") <= LOG_ROW_MAX_BYTES) return line;
  const { annotations: _annotations, spans: _spans, ...lean } = row;
  line = JSON.stringify(lean);
  if (Buffer.byteLength(line, "utf8") <= LOG_ROW_MAX_BYTES || lean.failure === undefined) return line;
  const { detail, ...head } = lean.failure;
  const failure: EncodedFailure = { ...head, causes: [], causesCut: true, ...(detail === undefined ? {} : { detailCut: true }) };
  return JSON.stringify({ ...lean, failure });
};

const isError = (value: unknown): value is Error => value instanceof Error;

/** Message parts as text; the first Error among them is the row's failure. */
const splitParts = (parts: ReadonlyArray<unknown>): { readonly message: string; readonly failure: unknown } => {
  let failure: unknown;
  const text: string[] = [];
  for (const part of parts) {
    if (failure === undefined && isError(part)) {
      failure = part;
      continue;
    }
    if (typeof part === "string") text.push(part);
    else text.push(annotationText(part));
  }
  return { message: text.join(" "), failure };
};

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

const CONSOLE_LEVEL: Record<ConsoleMethod, ObservabilityLogLevel> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

/**
 * `console` is one per process, so it is wrapped once. The first log that asks
 * owns the hook; a later log in the same process does not wrap it again.
 */
let consoleHookInstalled = false;

/**
 * The process's log. One per boot, holding the values that boot chose: where
 * its rows go, its machine name, its process, and whether it echoes. A test
 * constructs the log it exercises, the same way.
 */
export const createLogger = (options: LogOptions): Log => {
  let sink = options.sink;
  let machine = options.machine ?? defaultMachineName();
  let file: MachineLogSink | undefined;

  const emit = (input: ObservabilityAppendInput): void => {
    sink?.(input);
  };

  /** Step 3's known values: this process's environment and the registry its boot handed in. */
  const knownValues = (): ReadonlyArray<string | undefined> =>
    knownSecretValues({ registered: options.knownSecrets?.() ?? [] });

  const writeLog = (input: LogInput): MachineLogRow => {
    const known = knownValues();
    const scrub = (text: string, max: number): string => scrubMessage(precut(text, known), known).slice(0, max);
    const ts = input.ts ?? Date.now();

    let area = DEFAULT_AREA[input.source];
    let message = input.message;
    if (input.source === "main" || input.source === "renderer") {
      const prefix = CONSOLE_PREFIX.exec(message)?.[1]?.toLowerCase();
      if (prefix !== undefined) area = prefix;
    }
    let operationId: string | undefined;
    let seat: MachineLogRow["seat"];
    let canvas: MachineLogRow["canvas"];
    const annotations: Record<string, string> = {};
    // An encoded failure annotated on the log is the row's failure, kept typed.
    let annotatedFailure: unknown;
    for (const [key, value] of Object.entries(input.annotations ?? {})) {
      if (key === "failure" && isEncodedFailure(value)) {
        annotatedFailure = value;
        continue;
      }
      const text = annotationText(value);
      if (key === "area" && AREA.test(text)) area = text;
      else if (key === "operationId" && OPERATION_ID.test(text)) operationId = text;
      // Ids are validated, never scrubbed: the scrub's long-run rule would
      // erase them. An invalid one is dropped.
      else if (key === "seat") seat = isLogSeatId(text) ? text : undefined;
      else if (key === "canvas") canvas = isLogCanvasName(text) ? text : undefined;
      else if (LOG_ID_ANNOTATIONS.has(key)) {
        // A known secret value is never an id, whatever key it arrives under.
        if (Object.keys(annotations).length < MAX_ANNOTATIONS && isLogIdAnnotation(key, text) && !known.includes(text)) annotations[key] = text;
      }
      else if (Object.keys(annotations).length < MAX_ANNOTATIONS && /^[A-Za-z0-9_.-]{1,64}$/u.test(key)) {
        annotations[key] = scrub(text, 256);
      }
    }
    message = scrubMessage(precut(message, known), known);
    const held = input.failure ?? annotatedFailure;
    const failure = held === undefined
      ? undefined
      : isEncodedFailure(held)
        ? decodeEncodedFailure(held, known)
        : encodeFailure(held, {
            machine,
            known,
            ...(operationId === undefined ? {} : { operationId }),
            ...(input.detail === undefined ? {} : { detail: input.detail }),
          });
    // A failure whose detail names a seat belongs to that seat's scope.
    seat ??= failureDetailSeat(failure);
    const spans = (input.spans ?? []).slice(0, 16).map((span) => scrub(span, 128)).filter((span) => span.length > 0);

    const row: MachineLogRow = {
      time: new Date(ts).toISOString(),
      level: input.level,
      machine,
      process: options.process,
      source: input.source,
      area,
      message,
      ...(operationId === undefined ? {} : { operationId }),
      ...(seat === undefined ? {} : { seat }),
      ...(canvas === undefined ? {} : { canvas }),
      ...(failure === undefined ? {} : { failure }),
      ...(spans.length === 0 ? {} : { spans }),
      ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
    };

    const shown = failure === undefined ? message : `${message}${message ? " - " : ""}${failure.tag}: ${failure.message}`;
    emit({
      level: row.level,
      source: row.source,
      message: shown || "(empty)",
      ts,
      ...(input.fiber === undefined ? {} : { fiber: input.fiber }),
      ...(spans.length === 0 ? {} : { spans }),
      annotations: {
        area,
        ...(operationId === undefined ? {} : { operationId }),
        ...(seat === undefined ? {} : { seat }),
        ...(canvas === undefined ? {} : { canvas }),
        ...annotations,
      },
    });

    if (file !== undefined && OBSERVABILITY_LEVEL_RANK[row.level] >= OBSERVABILITY_LEVEL_RANK[FILE_MIN_LEVEL]) {
      file.write(fitRow(row));
    }
    if (options.echo && input.source !== "main") {
      try {
        process.stdout.write(`[${input.source}:${row.level}] ${shown.replace(/\n/g, " - ")}\n`);
      } catch {
        // stdout closed during shutdown; the ring and the file still hold the row.
      }
    }
    return row;
  };

  /**
   * Single Effect log sink. Replaces the default pretty console logger so
   * Effect logs are not captured twice through the console hook.
   */
  const effectLogger = Logger.make<unknown, void>((options_) => {
    const parts = Array.isArray(options_.message) ? options_.message : [options_.message];
    const split = splitParts(parts);
    const causeEmpty = options_.cause.reasons.length === 0;
    if (!split.message && causeEmpty && split.failure === undefined) return;
    const spans = options_.fiber.getRef(References.CurrentLogSpans).map(([label]) => label);
    writeLog({
      level: levelFromEffect(options_.logLevel),
      source: "effect",
      message: split.message,
      failure: causeEmpty ? split.failure : options_.cause,
      annotations: options_.fiber.getRef(References.CurrentLogAnnotations),
      spans,
      ts: options_.date.getTime(),
      fiber: String(options_.fiber.id),
    });
  });

  /**
   * Replace default console logger: one Effect path into the ring and the file.
   * V4: Logger.layer installs the set (mergeWithExisting false).
   */
  const loggerLayer = Layer.merge(
    Logger.layer([effectLogger], { mergeWithExisting: false }),
    Layer.sync(LogService, () => log),
  );

  /**
   * A runtime's layer with this log's machine logger beneath it. Merged beside,
   * the logger reaches only effects the runtime runs; a fiber a service forks
   * while its layer builds (a link session, a seat watcher) keeps Effect's
   * default logger, whose console line the hook then files as scrubbed text.
   */
  const withLogger = <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A | LogService, E, Exclude<R, LogService>> =>
    layer.pipe(Layer.provideMerge(loggerLayer));

  const installConsoleHook = (hookOptions: { readonly echo?: boolean } = {}): void => {
    if (consoleHookInstalled) return;
    consoleHookInstalled = true;
    const echo = hookOptions.echo ?? true;
    let depth = 0;

    const wrap =
      (method: ConsoleMethod, original: (...args: unknown[]) => void) =>
      (...args: unknown[]) => {
        if (depth > 0) {
          original.apply(console, args);
          return;
        }
        depth += 1;
        try {
          if (echo || file === undefined) original.apply(console, args);
          const split = splitParts(args);
          if (!split.message && split.failure === undefined) return;
          writeLog({ level: CONSOLE_LEVEL[method], source: "main", message: split.message, failure: split.failure });
        } finally {
          depth -= 1;
        }
      };

    console.log = wrap("log", console.log.bind(console));
    console.info = wrap("info", console.info.bind(console));
    console.warn = wrap("warn", console.warn.bind(console));
    console.error = wrap("error", console.error.bind(console));
    console.debug = wrap("debug", console.debug.bind(console));
  };

  const recordRendererConsole = (input: RendererConsoleInput): void => {
    const level: ObservabilityLogLevel =
      input.level === "warning"
        ? "warn"
        : input.level === "error"
          ? "error"
          : input.level === "debug"
            ? "debug"
            : "info";
    const loc =
      input.sourceId !== undefined
        ? ` (${input.sourceId}${input.lineNumber !== undefined ? `:${input.lineNumber}` : ""})`
        : "";
    writeLog({ level, source: "renderer", message: `${input.message}${loc}` });
  };

  const recordSystemLog = (message: string, level: ObservabilityLogLevel = "info"): void => {
    writeLog({ level, source: "system", message });
  };

  const log: Log = {
    writeLog,
    machine: () => machine,
    setMachine: (name) => {
      machine = name;
    },
    openFile: (install) => {
      file?.close();
      file = openMachineLogSink({
        home: install.home,
        process: options.process,
        onWriteFailure: (cause) => {
          const failure = encodeFailure(cause, { machine });
          emit({
            level: "error",
            source: "system",
            message: `the machine log could not be written${failure === undefined ? "" : `: ${failure.tag} ${failure.message}`}`,
          });
        },
      });
    },
    closeFile: () => {
      file?.close();
      file = undefined;
    },
    stopRows: () => {
      sink = undefined;
    },
    installConsoleHook,
    recordRendererConsole,
    recordSystemLog,
    effectLogger,
    loggerLayer,
    withLogger,
  };
  return log;
};
