/**
 * The live overseer host's program, a declared entry of the build beside the
 * core's (`overseer-host`). A junto-overseer seat runs it as its occupant on
 * the Node Junto runs on (src/core/term/templates/node-host.ts), with the
 * seat's argv after it. A build without Live refuses to start it.
 */
import { LIVE_OVERSEER_ENABLED } from "@shared/features";
import { runOverseerHost } from "./main";

if (LIVE_OVERSEER_ENABLED) {
  await runOverseerHost(process.argv.slice(2));
} else {
  process.stderr.write("Junto live conversation is disabled in this build\n");
  process.exitCode = 2;
}
