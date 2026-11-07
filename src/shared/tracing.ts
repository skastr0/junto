/**
 * Junto's OpenTelemetry export, on Effect's own OTLP modules: each process
 * builds one tracer and one log exporter, to the collector its environment
 * names, and nothing else. It is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` or
 * `JUNTO_OTLP_URL` is set; off, no layer is built, no request is made and
 * Effect's default tracer stays.
 *
 * A call that crosses a process carries its span on the rpc link
 * (`supportsSpanPropagation` in rpc-port.ts), so a window to main to core call
 * is one trace with nothing added per call. The window exports through main
 * (`OTLP_PROXY_PATH`), so its page never reaches a collector.
 */
import { Cause, Duration, Effect, Layer, Logger, Tracer } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpExporter, OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability";

export { OTLP_PROXY_PATH, otlpBaseUrl } from "./tracing-switch";

export type TracedProcess = "junto-main" | "junto-core" | "junto-terminal" | "junto-window";

/**
 * The longest a closing exporter waits on its last flush. A collector that is
 * gone, or a core that went with a span still buffered, never holds a quit.
 */
export const TRACING_SHUTDOWN_TIMEOUT = Duration.seconds(2);

export type TracingOptions = {
  readonly serviceName: TracedProcess;
  readonly serviceVersion: string;
  readonly baseUrl: string;
  readonly exportInterval?: Duration.Input | undefined;
  /**
   * The process's log scrub, as its own log applies it (src/node/credentials/scrub.ts):
   * each exported line goes through it first.
   */
  readonly scrub?: ((text: string) => string) | undefined;
};

const textOf = (part: unknown): string => {
  if (typeof part === "string") return part;
  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
};

/**
 * A log exporter whose lines leave scrubbed, as text. A line's cause stays in
 * the process's own log, which scrubs a failure as a failure; here it would
 * leave as raw message and stack.
 */
const scrubbedLogger = (logger: Logger.Logger<unknown, void>, scrub: (text: string) => string) =>
  Logger.make<unknown, void>((entry) =>
    logger.log({ ...entry, message: (Array.isArray(entry.message) ? entry.message : [entry.message]).map((part) => scrub(textOf(part))), cause: Cause.empty }),
  );

/**
 * A process's tracer and log exporter, sharing one flusher. They live in the
 * scope that builds them; closing it exports what is buffered, bounded.
 * Log lines leave without their log spans: a span name is code's, a log
 * span's value can be anything a caller put there.
 */
export const makeProcessTracing = (options: TracingOptions) =>
  Effect.gen(function* () {
    const resource = { serviceName: options.serviceName, serviceVersion: options.serviceVersion };
    const shared = { resource, exportInterval: options.exportInterval, shutdownTimeout: TRACING_SHUTDOWN_TIMEOUT };
    const tracer = yield* OtlpTracer.make({ ...shared, url: `${options.baseUrl}/v1/traces` });
    const exporter = yield* OtlpLogger.make({ ...shared, url: `${options.baseUrl}/v1/logs`, excludeLogSpans: true });
    return { tracer, logger: options.scrub === undefined ? exporter : scrubbedLogger(exporter, options.scrub) };
  }).pipe(Effect.provide([OtlpExporter.layerFlusher, OtlpSerialization.layerJson, FetchHttpClient.layer]));

export type ProcessTracing = Effect.Success<ReturnType<typeof makeProcessTracing>>;

/**
 * The loggers a runtime has, with the log exporter beside them and Effect's
 * span-event logger taken out: a line leaves once, through the exporter,
 * scrubbed and carrying its span's ids, never raw as an event on that span.
 */
export const exportingLoggers = (logger: Logger.Logger<unknown, void>): Layer.Layer<never> =>
  Layer.effect(
    Logger.CurrentLoggers,
    Effect.map(Logger.CurrentLoggers, (current) => new Set([...[...current].filter((each) => each !== Logger.tracerLogger), logger])),
  );

/** A runtime's share of a built tracing: its tracer, and its log exporter beside the loggers it has. */
export const tracingLayerOf = (tracing: ProcessTracing): Layer.Layer<never> =>
  Layer.mergeAll(Layer.succeed(Tracer.Tracer, tracing.tracer), exportingLoggers(tracing.logger));

/**
 * One runtime's tracing, built with the runtime and flushed when it closes.
 * Without a collector it is `Layer.empty`, so an off build adds nothing.
 */
export const processTracingLayer = (options: Omit<TracingOptions, "baseUrl"> & { readonly baseUrl: string | undefined }): Layer.Layer<never> => {
  const baseUrl = options.baseUrl;
  return baseUrl === undefined ? Layer.empty : Layer.unwrap(Effect.map(makeProcessTracing({ ...options, baseUrl }), tracingLayerOf));
};
