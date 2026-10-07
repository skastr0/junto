#!/usr/bin/env bun
import { CLI_VERSION } from "./core/constants";
import { earlyDispatchFromArgv } from "./early-dispatch";
import { ARTIFACTS_ENABLED, BOARD_ENABLED, BROWSER_ENABLED, FLEET_UI_ENABLED,
  LIVE_OVERSEER_ENABLED, PAD_ENABLED, SHEET_ENABLED, TASKS_ENABLED } from "@shared/features";

declare const __JUNTO_BROWSER_ENABLED__: boolean | undefined;
const browserCliAvailable = typeof __JUNTO_BROWSER_ENABLED__ !== "boolean" || BROWSER_ENABLED;
export { browserCliArgsFromArgv } from "./browser-argv";
export { earlyDispatchFromArgv } from "./early-dispatch";

/**
 * A command group whose product feature is off in this build. Named so the
 * entrypoint can refuse with one sentence before the unregistered command
 * collapses into a generic usage error.
 */
const disabledCliGroup = (args: ReadonlyArray<string>): string | undefined => {
  const group = args[0];
  if (!TASKS_ENABLED && group === "tasks") return "tasks";
  if (!TASKS_ENABLED && group === "rulings") return "rulings";
  if (!TASKS_ENABLED && group === "content") return "content";
  if (!BOARD_ENABLED && group === "board") return "board";
  if (!PAD_ENABLED && group === "pad") return "pad";
  if (!SHEET_ENABLED && group === "sheet") return "sheet";
  if (!ARTIFACTS_ENABLED && group === "artifact") return "artifact";
  return undefined;
};

// When executed as the CLI entrypoint (bun / compiled binary).
if (import.meta.main) {
  // Bun puts user args at index 2 in both modes: source is
  // [bunPath, script, ...args], compiled is ["bun", "/$bunfs/root/junto",
  // ...args]. V4 runWith takes user args only — never the full argv.
  const dispatch = earlyDispatchFromArgv(Bun.argv);
  if (dispatch.kind === "overseer-host") {
    if (LIVE_OVERSEER_ENABLED) {
      await (await import("../overseer-host/main")).runOverseerHost(dispatch.args);
    } else {
      process.stderr.write("Junto live conversation is disabled in this build\n");
      process.exitCode = 2;
    }
  } else if (dispatch.kind === "browser") {
    if (!browserCliAvailable) {
      process.stderr.write("junto browser: disabled in this build\n");
      process.exitCode = 2;
    } else {
      await (await import("../../scripts/browser-cli")).runBrowserCli(dispatch.args);
    }
  } else if (
    dispatch.kind === "cli" &&
    !FLEET_UI_ENABLED &&
    (dispatch.args[0] === "fleet" || dispatch.args[0] === "qualification")
  ) {
    process.stderr.write(
      `junto ${dispatch.args[0]}: disabled in this Junto build\n`,
    );
    process.exitCode = 2;
  } else if (
    dispatch.kind === "cli" &&
    disabledCliGroup(dispatch.args) !== undefined
  ) {
    process.stderr.write(
      `junto ${disabledCliGroup(dispatch.args)}: disabled in this Junto build\n`,
    );
    process.exitCode = 2;
  } else if (dispatch.kind === "station-stdio") {
    await (await import("./station-stdio")).runStationStdio(dispatch.args);
  } else if (dispatch.kind === "content-transfer") {
    await (await import("./content-transfer")).runContentTransfer(dispatch.args);
  } else if (dispatch.kind === "companion-stdio") {
    await (await import("./companion-stdio")).runCompanionStdio(dispatch.args);
  } else if (dispatch.args.length === 1 && dispatch.args[0] === "--version") {
    process.stdout.write(`junto v${CLI_VERSION}\n`);
  } else {
    const { BunRuntime } = await import("@effect/platform-bun");
    const { runCli } = await import("./command-runner");
    BunRuntime.runMain(
      runCli(dispatch.args),
    );
  }
}
