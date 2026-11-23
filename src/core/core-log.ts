import { createLogger, type Log } from "../node/observability/logger";
import { registeredSecretValues } from "./credentials/known-secrets";
import { observabilityRing } from "./observability/ring";

/**
 * A core process's log, the same for the core inside the app and a windowless
 * one: every row lands in its ring (the panel reads it) and in
 * `<home>/.junto/logs/core.jsonl`, scrubbed with the secrets this core holds,
 * and `console.*` takes the same path. Without the file, the dialing end of
 * every link kept no record of it (docs/machines.md, "Every machine keeps a
 * log").
 *
 * `echo` also prints each row to stdout: the app's core inherits a stdout a
 * person reads in a dev run, and a windowless core's stdout is an unbounded
 * service file, so it does not.
 */
export const openCoreLog = (options: { readonly home: string; readonly echo: boolean }): Log => {
  const log = createLogger({
    process: "core",
    echo: options.echo,
    sink: (row) => observabilityRing.append(row),
    knownSecrets: registeredSecretValues,
  });
  log.openFile({ home: options.home });
  log.installConsoleHook({ echo: options.echo });
  return log;
};
