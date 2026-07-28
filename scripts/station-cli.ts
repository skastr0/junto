#!/usr/bin/env bun
import { relayStationControlSession } from "../src/main/vellum/station/control-relay";
import { STATION_PROTOCOL_NEGOTIATION_ARG } from "../src/shared/station-protocol";

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const admitted =
    args.length === 0 ||
    (
      args.length === 1 &&
      args[0] === STATION_PROTOCOL_NEGOTIATION_ARG
    );
  if (!admitted) {
    process.stderr.write("vellum-station: arguments are not accepted\n");
    process.exitCode = 64;
    return;
  }

  try {
    await relayStationControlSession();
  } catch {
    process.stderr.write("vellum-station: relay failed\n");
    process.exitCode = 1;
  }
};

await main();
