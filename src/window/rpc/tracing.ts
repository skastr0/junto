/**
 * The window's tracing (src/shared/tracing.ts): `junto-window`, exported to
 * main's proxy below the page's own origin, so the page's CSP stays closed
 * to any collector. On only when main's environment names one, which the
 * preload passes as `junto.tracing`; off, it is `Layer.empty`.
 */
import { version } from "../../../package.json";
import { OTLP_PROXY_PATH, processTracingLayer } from "@shared/tracing";

export const windowTracing = (on: boolean, origin: string) =>
  processTracingLayer({ serviceName: "junto-window", serviceVersion: version, baseUrl: on ? `${origin}${OTLP_PROXY_PATH}` : undefined });
