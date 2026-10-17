import { Logger, References, Schema, type LogLevel } from "effect";
import type { ObservabilityLogLevel, ObservabilityLogSource } from "@shared/observability";
import { OBSERVABILITY_LEVEL_RANK } from "@shared/observability";
import {
  LOG_ROW_MAX_BYTES,
  LogCanvasName,
  LogSeatId,
  failureDetailSeat,
  type LogProcess,
  type MachineLogRow,
} from "@shared/machine-log";
import { EncodedFailure } from "@shared/failure";
import { defaultMachineName } from "@shared/machine-name";
import { observabilityRing } from "./ring";
import { redactSecretValues } from "../credentials/redact";
import { knownSecretValues, scrubMessage } from "../credentials/scrub";
import { decodeEncodedFailure, encodeFailure } from "../failure-encode";
import { openMachineLogSink, type MachineLogSink } from "./log-file";

/**
 * The one log path. Effect logs, `console.*` in main, renderer console lines
 * and system notes all become one row here: scrubbed once
 * (docs/security-doctrine.md, Failures and logs), then appended to the
 * in-process ring, to this machine's log file when one is installed, and to
 * stdout when this process echoes.
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

type LogState = {
  sink: MachineLogSink | undefined;
  machine: string;
  process: LogProcess;
  echo: boolean;
};

const state: LogState = { sink: undefined, machine: defaultMachineName(), process: "app", echo: true };

export type MachineLogInstall = {
  readonly home: string;
  readonly process: LogProcess;
  /** Also print each row to stdout. A windowless core does not: its stdout is an unbounded service file. */
  readonly echo: boolean;
};

/** Open this process's log file. Idempotent per process; a second install replaces the first. */
export const installMachineLog = (install: MachineLogInstall): void => {
  state.sink?.close();
  state.process = install.process;
  state.echo = install.echo;
  state.sink = openMachineLogSink({
    home: install.home,
    process: install.process,
    onWriteFailure: (cause) => {
      const failure = encodeFailure(cause, { machine: state.machine });
      observabilityRing.append({
        level: "error",
        source: "system",
        message: `the machine log could not be written${failure === undefined ? "" : `: ${failure.tag} ${failure.message}`}`,
      });
    },
  });
};

/** The machine name rows carry. */
export const logMachine = (): string => state.machine;

/** The machine's configured name, once the machine repository has it. */
export const setLogMachine = (name: string): void => {
  state.machine = name;
};

export const closeMachineLog = (): void => {
  state.sink?.close();
  state.sink = undefined;
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

/** Build one scrubbed row and send it to every sink. Returns the row. */
export const writeLog = (input: LogInput): MachineLogRow => {
  const known = knownSecretValues();
  const scrub = (text: string, max: number): string => scrubMessage(precut(text, known), known).slice(0, max);
  const ts = input.ts ?? Date.now();

  let area = DEFAULT_AREA[input.source];
  let message = input.message;
  if (input.source === "main") {
    const prefix = CONSOLE_PREFIX.exec(message)?.[1]?.toLowerCase();
    if (prefix !== undefined) area = prefix;
  }
  let operationId: string | undefined;
  let seat: MachineLogRow["seat"];
  let canvas: MachineLogRow["canvas"];
  const annotations: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.annotations ?? {})) {
    const text = annotationText(value);
    if (key === "area" && AREA.test(text)) area = text;
    else if (key === "operationId" && OPERATION_ID.test(text)) operationId = text;
    // Ids are validated, never scrubbed: the scrub's long-run rule would
    // erase them. An invalid one is dropped.
    else if (key === "seat") seat = isLogSeatId(text) ? text : undefined;
    else if (key === "canvas") canvas = isLogCanvasName(text) ? text : undefined;
    else if (Object.keys(annotations).length < MAX_ANNOTATIONS && /^[A-Za-z0-9_.-]{1,64}$/u.test(key)) {
      annotations[key] = scrub(text, 256);
    }
  }
  message = scrubMessage(precut(message, known), known);
  const failure = input.failure === undefined
    ? undefined
    : isEncodedFailure(input.failure)
      ? decodeEncodedFailure(input.failure)
      : encodeFailure(input.failure, {
          machine: state.machine,
          ...(operationId === undefined ? {} : { operationId }),
          ...(input.detail === undefined ? {} : { detail: input.detail }),
        });
  // A failure whose detail names a seat belongs to that seat's scope.
  seat ??= failureDetailSeat(failure);
  const spans = (input.spans ?? []).slice(0, 16).map((span) => scrub(span, 128)).filter((span) => span.length > 0);

  const row: MachineLogRow = {
    time: new Date(ts).toISOString(),
    level: input.level,
    machine: state.machine,
    process: state.process,
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
  observabilityRing.append({
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

  if (state.sink !== undefined && OBSERVABILITY_LEVEL_RANK[row.level] >= OBSERVABILITY_LEVEL_RANK[FILE_MIN_LEVEL]) {
    state.sink.write(fitRow(row));
  }
  if (state.echo && input.source !== "main") {
    try {
      process.stdout.write(`[${input.source}:${row.level}] ${shown.replace(/\n/g, " - ")}\n`);
    } catch {
      // stdout closed during shutdown; the ring and the file still hold the row.
    }
  }
  return row;
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

/**
 * Single Effect log sink. Replaces the default pretty console logger so
 * Effect logs are not captured twice through the console hook.
 */
export const ObservabilityEffectLogger = Logger.make<unknown, void>((options) => {
  const parts = Array.isArray(options.message) ? options.message : [options.message];
  const split = splitParts(parts);
  const causeEmpty = options.cause.reasons.length === 0;
  if (!split.message && causeEmpty && split.failure === undefined) return;
  const spans = options.fiber.getRef(References.CurrentLogSpans).map(([label]) => label);
  writeLog({
    level: levelFromEffect(options.logLevel),
    source: "effect",
    message: split.message,
    failure: causeEmpty ? split.failure : options.cause,
    annotations: options.fiber.getRef(References.CurrentLogAnnotations),
    spans,
    ts: options.date.getTime(),
    fiber: String(options.fiber.id),
  });
});

/**
 * Replace default console logger: one Effect path into the ring and the file.
 * V4: Logger.layer installs the set (mergeWithExisting false).
 */
export const ObservabilityLoggerLive = Logger.layer([ObservabilityEffectLogger], {
  mergeWithExisting: false,
});

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

const CONSOLE_LEVEL: Record<ConsoleMethod, ObservabilityLogLevel> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

let consoleHookInstalled = false;

/**
 * Route main-process `console.*` through `writeLog`. Idempotent. A leading
 * `[name]` becomes the row's area; the first Error argument becomes its
 * encoded failure. With `echo` off the original console is not called once a
 * log file is installed, so nothing unscrubbed reaches a service's stdio.
 * Depth guards nested console calls made while a row is written.
 */
export const installObservabilityConsoleHook = (options: { readonly echo?: boolean } = {}): void => {
  if (consoleHookInstalled) return;
  consoleHookInstalled = true;
  const echo = options.echo ?? true;
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
        if (echo || state.sink === undefined) original.apply(console, args);
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

/** Feed a renderer console-message event into the log. */
export const recordRendererConsole = (input: {
  readonly level: "debug" | "info" | "warning" | "error";
  readonly message: string;
  readonly sourceId?: string;
  readonly lineNumber?: number;
}): void => {
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

export const recordSystemLog = (
  message: string,
  level: ObservabilityLogLevel = "info",
): void => {
  writeLog({ level, source: "system", message });
};
