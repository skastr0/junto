/**
 * The switch for tracing (tracing.ts), with no imports, so the preload can
 * read it without bundling an exporter.
 */

/** The collector's base URL from the environment, or undefined: tracing is off. */
export const otlpBaseUrl = (env: Readonly<Record<string, string | undefined>>): string | undefined => {
  const url = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || env.JUNTO_OTLP_URL?.trim();
  return url ? url.replace(/\/+$/, "") : undefined;
};

/** Where main serves the window's exports, below the window's own origin. */
export const OTLP_PROXY_PATH = "/otlp";
