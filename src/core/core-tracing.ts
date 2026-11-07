/**
 * The core process's tracing (src/shared/tracing.ts): `junto-core`, on the
 * collector main's environment names, provided where the core builds its one
 * runtime (core-runtime.ts). Off, it is `Layer.empty`.
 */
import productMetadata from "../../package.json";
import { knownSecretValues, scrubMessage } from "../node/credentials/scrub";
import { otlpBaseUrl, processTracingLayer } from "../shared/tracing";
import { registeredSecretValues } from "./credentials/known-secrets";

/** An exported log line, scrubbed as the core's own log scrubs it: the environment's and the registry's values. */
export const scrubCoreLog = (text: string): string => scrubMessage(text, knownSecretValues({ registered: registeredSecretValues() }));

export const CoreTracing = processTracingLayer({
  serviceName: "junto-core",
  serviceVersion: productMetadata.version,
  baseUrl: otlpBaseUrl(process.env),
  scrub: scrubCoreLog,
});
