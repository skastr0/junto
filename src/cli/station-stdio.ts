/**
 * Packaged station wire entry — `vellum-command station-stdio`.
 *
 * One binary: agents and ssh forced-commands invoke this subcommand instead of
 * a separate vellum-command-station executable.
 */
import { relayStationControlSession } from "../main/vellum/station/control-relay";
import {
  STATION_PROTOCOL_NEGOTIATION_ARG,
  STATION_STDIO_COMMAND,
} from "../main/vellum/station/helper-contract";

export { STATION_STDIO_COMMAND };

/**
 * Admit station-stdio argv: no args, optional `stdio` synonym already stripped
 * by the dispatcher, or the single protocol-preface token.
 */
export const admitStationStdioArgs = (
  args: ReadonlyArray<string>,
): boolean =>
  args.length === 0 ||
  (args.length === 1 && args[0] === STATION_PROTOCOL_NEGOTIATION_ARG);

export const runStationStdio = async (
  args: ReadonlyArray<string>,
): Promise<void> => {
  if (!admitStationStdioArgs(args)) {
    process.stderr.write("vellum-command station-stdio: arguments are not accepted\n");
    process.exitCode = 64;
    return;
  }

  try {
    await relayStationControlSession();
  } catch {
    process.stderr.write("vellum-command station-stdio: relay failed\n");
    process.exitCode = 1;
  }
};
