#!/usr/bin/env bun
import { relayStationControlSession } from "../src/main/vellum/station/control-relay";

const main = async (): Promise<void> => {
  if (process.argv.slice(2).length > 0) {
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
