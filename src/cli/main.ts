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
import {
  artifactCommand,
  boardCommand,
  escalateCommand,
  msgCommand,
  preambleCommand,
  tasksCommand,
} from "./commands/work";
import { contentCommand } from "./commands/content";
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
import { BROWSER_ENABLED } from "@shared/features";

declare const __VELLUM_COMMAND_BROWSER_ENABLED__: boolean | undefined;
const browserCliAvailable =
  typeof __VELLUM_COMMAND_BROWSER_ENABLED__ !== "boolean" || BROWSER_ENABLED;
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
    "Vellum Command agent and direct-operator protocol surfaces (JSON only)",
  ),
  Command.withSubcommands([
    pingCommand,
    doctorCommand,
    capabilitiesCommand,
    onboardCommand,
    schemaCommand,
    examplesCommand,
    preambleCommand,
    tasksCommand,
    msgCommand,
    escalateCommand,
    artifactCommand,
    contentCommand,
    boardCommand,
    stationOperatorCommand,
    fleetOperatorCommand,
    qualificationOperatorCommand,
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
  // [bunPath, script, ...args], compiled is ["bun", "/$bunfs/root/vellum-command",
  // ...args]. V4 runWith takes user args only — never the full argv.
  const dispatch = earlyDispatchFromArgv(Bun.argv);
  if (dispatch.kind === "browser") {
    if (!browserCliAvailable) {
      process.stderr.write("vellum-command browser: disabled in this build\n");
      process.exitCode = 2;
    } else {
      await runBrowserCli(dispatch.args);
    }
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
