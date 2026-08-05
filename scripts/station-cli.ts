#!/usr/bin/env bun
/**
 * Dev convenience shim. Packaged installs use `vellum station-stdio` only.
 */
import { runStationStdio } from "../src/cli/station-stdio";

await runStationStdio(process.argv.slice(2));
