/**
 * The terminal process's tracing (src/shared/tracing.ts): `junto-terminal`,
 * provided where entry.ts builds its runtime. It traces the process's Effect
 * calls only; the byte path keeps its own journal (pty-delivery-trace.ts).
 * Off, it is `Layer.empty`.
 */
import productMetadata from "../../package.json";
import { scrubMessage } from "../node/credentials/scrub";
import { otlpBaseUrl, processTracingLayer } from "../shared/tracing";

export const TerminalTracing = processTracingLayer({
  serviceName: "junto-terminal",
  serviceVersion: productMetadata.version,
  baseUrl: otlpBaseUrl(process.env),
  scrub: (text) => scrubMessage(text),
});
