#!/usr/bin/env bun
import * as Cause from "effect/Cause";
// V4: @effect/cli → effect/unstable/cli · platform-bun stays separate (lockstep V4)
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
import { browserCliArgsFromArgv } from "./browser-argv";
import { CLI_NAME, CLI_VERSION } from "./core/constants";
import {
  setExitCode,
  writeCauseEnvelope,
  writeFailureEnvelope,
} from "./core/output";
import { OperatorSocketLive } from "./core/operator-socket";
import { WorkSocketLive } from "./core/socket";

export { browserCliArgsFromArgv } from "./browser-argv";

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
  // Source execution has [bun, script, ...args]; the compiled executable has
  // [vellum, ...args]. Only the top-level command dispatches Browser. A later
  // `browser` value (for example `--capability browser`) remains CLI data.
  const browserArgs = browserCliArgsFromArgv(Bun.argv);
  if (browserArgs !== undefined) {
    await runBrowserCli(browserArgs);
  } else {
    BunRuntime.runMain(
      runCli(Bun.argv) as Effect.Effect<void, never, never>,
    );
  }
}

void Cause;
