/**
 * A test's log: one value, with a recording row sink and no file or stdout
 * unless the test asks. Constructing the log a test exercises is the point of
 * `createLogger`; nothing here installs process-wide state.
 */
import { createLogger, type Log, type LogOptions } from "../../src/node/observability/logger";
import type { ObservabilityAppendInput } from "../../src/core/observability/ring";

export type TestLog = {
  readonly log: Log;
  /** Every row the log sent its sink, in order. */
  readonly rows: ObservabilityAppendInput[];
};

export const makeTestLog = (
  options: Partial<Omit<LogOptions, "sink">> & { readonly sink?: LogOptions["sink"] } = {},
): TestLog => {
  const rows: ObservabilityAppendInput[] = [];
  const log = createLogger({
    process: options.process ?? "core",
    echo: options.echo ?? false,
    sink: options.sink ?? ((row) => rows.push(row)),
    ...(options.machine === undefined ? {} : { machine: options.machine }),
    ...(options.knownSecrets === undefined ? {} : { knownSecrets: options.knownSecrets }),
  });
  return { log, rows };
};
