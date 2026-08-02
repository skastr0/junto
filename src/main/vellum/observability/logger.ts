import {
  Cause,
  FiberId,
  HashMap,
  HashSet,
  List,
  Logger,
  LogLevel,
  type LogSpan,
} from "effect";
import type { ObservabilityLogLevel } from "@shared/observability";
import { observabilityRing, recordObservabilityLog } from "./ring";

const levelFromEffect = (level: LogLevel.LogLevel): ObservabilityLogLevel => {
  switch (level._tag) {
    case "Trace":
      return "trace";
    case "Debug":
      return "debug";
    case "Info":
      return "info";
    case "Warning":
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

const formatMessage = (message: unknown): string => {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return message
      .map((part) => {
        if (typeof part === "string") return part;
        if (part instanceof Error) return part.stack ?? part.message;
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .join(" ");
  }
  if (message instanceof Error) return message.stack ?? message.message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
};

const fiberLabel = (fiberId: FiberId.FiberId): string | undefined => {
  const ids = FiberId.ids(fiberId);
  if (HashSet.size(ids) === 0) return undefined;
  return HashSet.toValues(ids).join(",");
};

const spanLabels = (
  spans: List.List<LogSpan.LogSpan>,
): ReadonlyArray<string> | undefined => {
  const labels = List.toArray(spans).map((span) => span.label);
  return labels.length > 0 ? labels : undefined;
};

const annotationMap = (
  annotations: HashMap.HashMap<string, unknown>,
): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const [key, value] of HashMap.toEntries(annotations)) {
    out[key] =
      typeof value === "string"
        ? value
        : value instanceof Error
          ? value.message
          : (() => {
              try {
                return JSON.stringify(value);
              } catch {
                return String(value);
              }
            })();
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Effect Logger that records into the process ring. Added via Layer — keeps
 * default pretty console logging; this is an additional sink.
 */
export const ObservabilityEffectLogger = Logger.make<unknown, void>((options) => {
  const causeText =
    options.cause._tag === "Empty" ? "" : Cause.pretty(options.cause);
  const base = formatMessage(options.message);
  const message = causeText ? (base ? `${base}\n${causeText}` : causeText) : base;
  if (!message && options.cause._tag === "Empty") return;

  observabilityRing.append({
    level: levelFromEffect(options.logLevel),
    source: "effect",
    message: message || "(empty)",
    ts: options.date.getTime(),
    fiber: fiberLabel(options.fiberId),
    spans: spanLabels(options.spans),
    annotations: annotationMap(options.annotations),
  });
});

export const ObservabilityLoggerLive = Logger.add(ObservabilityEffectLogger);

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
 * Mirror main-process console into the ring. Idempotent. Skips our own
 * re-entrancy via an ALS-style flag on the call stack.
 */
export const installObservabilityConsoleHook = (): void => {
  if (consoleHookInstalled) return;
  consoleHookInstalled = true;
  let depth = 0;

  const wrap =
    (method: ConsoleMethod, original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      original.apply(console, args);
      if (depth > 0) return;
      depth += 1;
      try {
        const message = args
          .map((arg) => {
            if (typeof arg === "string") return arg;
            if (arg instanceof Error) return arg.stack ?? arg.message;
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          })
          .join(" ");
        if (!message) return;
        recordObservabilityLog({
          level: CONSOLE_LEVEL[method],
          source: "main",
          message,
        });
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

/** Feed a renderer console-message event into the ring. */
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
  recordObservabilityLog({
    level,
    source: "renderer",
    message: `${input.message}${loc}`,
  });
};

export const recordSystemLog = (
  message: string,
  level: ObservabilityLogLevel = "info",
): void => {
  recordObservabilityLog({ level, source: "system", message });
};
