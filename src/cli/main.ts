#!/usr/bin/env bun
import * as Cause from "effect/Cause";
// V4: @effect/cli → effect/unstable/cli - platform-bun stays separate (lockstep V4)
// Map: ./effect-v4-import-map.ts
import { Command } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import {
  capabilitiesCommand,
  doctorCommand,
  examplesCommand,
  onboardCommand,
  pingCommand,
  schemaCommand,
} from "./commands/discovery";
import { overseerCommand } from "./commands/overseer";
import { padCommand } from "./commands/pad";
import { sheetCommand } from "./commands/sheet";
import { seatCommand } from "./commands/seat";
import {
  artifactCommand,
  boardCommand,
  msgCommand,
  preambleCommand,
  rulingsCommand,
  tasksCommand,
  verdictCommand,
} from "./commands/work";
import {
  blockedCommand,
  escalateCommand,
  feedbackCommand,
  signalCommand,
} from "./commands/signals";
import { contentCommand } from "./commands/content";
import { docsCommand } from "./commands/docs";
import {
  fleetOperatorCommand,
  qualificationOperatorCommand,
  stationOperatorCommand,
} from "./commands/operator";
import { runBrowserCli } from "../../scripts/browser-cli";
import { earlyDispatchFromArgv } from "./early-dispatch";
import { runContentTransfer } from "./content-transfer";
import { runStationStdio } from "./station-stdio";
import { CLI_NAME, CLI_VERSION } from "./core/constants";
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  BROWSER_ENABLED,
  FLEET_UI_ENABLED,
  LIVE_OVERSEER_ENABLED,
  PAD_ENABLED,
  SHEET_ENABLED,
  TASKS_ENABLED,
} from "@shared/features";
import { runOverseerHost } from "../overseer-host/main";

declare const __JUNTO_BROWSER_ENABLED__: boolean | undefined;
const browserCliAvailable =
  typeof __JUNTO_BROWSER_ENABLED__ !== "boolean" || BROWSER_ENABLED;
import {
  setExitCode,
  writeCauseEnvelope,
  writeFailureEnvelope,
} from "./core/output";
import { OperatorSocketLive } from "./core/operator-socket";
import { WorkSocketLive } from "./core/socket";

export { browserCliArgsFromArgv } from "./browser-argv";
export { earlyDispatchFromArgv } from "./early-dispatch";


export const rootCommand = Command.make(CLI_NAME).pipe(
  Command.withDescription(
    "Junto agent and direct-operator protocol surfaces (JSON only)",
  ),
  Command.withSubcommands([
    pingCommand,
    doctorCommand,
    capabilitiesCommand,
    onboardCommand,
    schemaCommand,
    examplesCommand,
    preambleCommand,
    escalateCommand,
    blockedCommand,
    feedbackCommand,
    signalCommand,
    ...(TASKS_ENABLED ? [tasksCommand] : []),
    rulingsCommand,
    msgCommand,
    seatCommand,
    verdictCommand,
    ...(TASKS_ENABLED ? [contentCommand] : []),
    docsCommand,
    ...(BOARD_ENABLED ? [boardCommand] : []),
    ...(PAD_ENABLED ? [padCommand] : []),
    ...(SHEET_ENABLED ? [sheetCommand] : []),
    ...(ARTIFACTS_ENABLED ? [artifactCommand] : []),
    overseerCommand,
    stationOperatorCommand,
    ...(FLEET_UI_ENABLED
      ? [fleetOperatorCommand, qualificationOperatorCommand]
      : []),
  ]),
);

// V4: runWith takes explicit argv; run() pulls from Stdio only.
const cli = Command.runWith(rootCommand, {
  version: CLI_VERSION,
});

const runtimeLayer = Layer.mergeAll(
  BunServices.layer,
  WorkSocketLive,
  OperatorSocketLive,
);

/**
 * A command group whose product feature is off in this build. Named so the
 * entrypoint can refuse with one sentence before the unregistered command
 * collapses into a generic usage error.
 */
const disabledCliGroup = (args: ReadonlyArray<string>): string | undefined => {
  const group = args[0];
  if (!TASKS_ENABLED && group === "tasks") return "tasks";
  if (!TASKS_ENABLED && group === "content") return "content";
  if (!BOARD_ENABLED && group === "board") return "board";
  if (!PAD_ENABLED && group === "pad") return "pad";
  if (!SHEET_ENABLED && group === "sheet") return "sheet";
  if (!ARTIFACTS_ENABLED && group === "artifact") return "artifact";
  return undefined;
};

export const runCli = (args: ReadonlyArray<string>) =>
  Effect.suspend(() => cli(args)).pipe(
    Effect.catch((error) =>
      setExitCode(1).pipe(Effect.andThen(writeFailureEnvelope(undefined, error))),
    ),
    Effect.catchCause((cause) =>
      setExitCode(1).pipe(Effect.andThen(writeCauseEnvelope(undefined, cause))),
    ),
    Effect.provide(runtimeLayer),
  );

// When executed as the CLI entrypoint (bun / compiled binary).
if (import.meta.main) {
  // Bun puts user args at index 2 in both modes: source is
  // [bunPath, script, ...args], compiled is ["bun", "/$bunfs/root/junto",
  // ...args]. V4 runWith takes user args only — never the full argv.
  const dispatch = earlyDispatchFromArgv(Bun.argv);
  if (dispatch.kind === "overseer-host") {
    if (LIVE_OVERSEER_ENABLED) {
      await runOverseerHost(dispatch.args);
    } else {
      process.stderr.write("Junto live conversation is disabled in this build\n");
      process.exitCode = 2;
    }
  } else if (dispatch.kind === "browser") {
    if (!browserCliAvailable) {
      process.stderr.write("junto browser: disabled in this build\n");
      process.exitCode = 2;
    } else {
      await runBrowserCli(dispatch.args);
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
    await runStationStdio(dispatch.args);
  } else if (dispatch.kind === "content-transfer") {
    await runContentTransfer(dispatch.args);
  } else {
    BunRuntime.runMain(
      runCli(dispatch.args) as Effect.Effect<void, never, never>,
    );
  }
}

void Cause;
