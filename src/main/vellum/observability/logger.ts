import { Cause, Logger, type LogLevel } from "effect";
import type { ObservabilityLogLevel } from "@shared/observability";
import { observabilityRing, recordObservabilityLog } from "./ring";

const levelFromEffect = (level: LogLevel.LogLevel): ObservabilityLogLevel => {
  // V4 LogLevel is a string union, not a tagged ADT.
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

/**
 * Single Effect log sink: ring + process.stdout (never console.*).
 *
 * Replaces the default pretty console logger so Effect logs are not
 * double-captured by the main console hook (which would burn ring capacity
 * and show every line twice as source effect + source main).
 *
 * Effect V4 Logger.Options: message, logLevel, cause, fiber, date.
 * Spans/annotations are not on Options — drop them.
 */
export const ObservabilityEffectLogger = Logger.make<unknown, void>((options) => {
  const causeEmpty = options.cause.reasons.length === 0;
  const causeText = causeEmpty ? "" : Cause.pretty(options.cause);
  const base = formatMessage(options.message);
  const message = causeText ? (base ? `${base}\n${causeText}` : causeText) : base;
  if (!message && causeEmpty) return;

  const level = levelFromEffect(options.logLevel);
  const text = message || "(empty)";
  const fiberId = options.fiber.id;

  observabilityRing.append({
    level,
    source: "effect",
    message: text,
    ts: options.date.getTime(),
    fiber: Number.isFinite(fiberId) ? String(fiberId) : undefined,
  });

  // Terminal visibility without touching hooked console.*
  try {
    process.stdout.write(`[effect:${level}] ${text.replace(/\n/g, " · ")}\n`);
  } catch {
    // stdout closed during shutdown — ignore
  }
});

/** Replace default console logger — one Effect path into the ring. */
export const ObservabilityLoggerLive = Logger.layer([ObservabilityEffectLogger]);

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
 * Mirror main-process console into the ring. Idempotent.
 * Depth wraps the original call so nested console.* from formatters
 * does not double-append.
 */
export const installObservabilityConsoleHook = (): void => {
  if (consoleHookInstalled) return;
  consoleHookInstalled = true;
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
        original.apply(console, args);
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
