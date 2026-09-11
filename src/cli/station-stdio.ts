/**
 * Packaged station wire entry — `vellum-command station-stdio`.
 *
 * One binary: agents and ssh forced-commands invoke this subcommand instead of
 * a separate vellum-command-station executable.
 */
import type { StationDoor } from "@shared/station-mode";
import { relayStationControlSession } from "../main/vellum-command/station/control-relay";
import {
  STATION_PEER_ARG,
  STATION_PROTOCOL_NEGOTIATION_ARG,
  STATION_STDIO_COMMAND,
} from "../main/vellum-command/station/helper-contract";

export { STATION_STDIO_COMMAND };

/**
 * Admit station-stdio argv: no args (peer), optional `--peer`, or the
 * single protocol-preface token (enroll). Never both doors.
 */
export const admitStationStdioArgs = (
  args: ReadonlyArray<string>,
): boolean =>
  args.length === 0 ||
  (args.length === 1 &&
    (args[0] === STATION_PROTOCOL_NEGOTIATION_ARG ||
      args[0] === STATION_PEER_ARG));

export const stationStdioDoor = (
  args: ReadonlyArray<string>,
): StationDoor =>
  args[0] === STATION_PROTOCOL_NEGOTIATION_ARG ? "enroll" : "peer";

export const runStationStdio = async (
  args: ReadonlyArray<string>,
): Promise<void> => {
  if (!admitStationStdioArgs(args)) {
    process.stderr.write("vellum-command station-stdio: arguments are not accepted\n");
    process.exitCode = 64;
    return;
  }

  try {
    await relayStationControlSession({ door: stationStdioDoor(args) });
  } catch {
    process.stderr.write("vellum-command station-stdio: relay failed\n");
    process.exitCode = 1;
  }
};
