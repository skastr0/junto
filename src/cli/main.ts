#!/usr/bin/env bun
import * as Cause from "effect/Cause";
// S7 V4 import map (do not rewrite on effect@3.21):
//   @effect/cli → effect/unstable/cli/*  ·  platform-bun stays separate (lockstep V4)
//   Full table: ./effect-v4-import-map.ts · Playground/effect/migration/v3-to-v4.md
import { Command } from "@effect/cli";
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
import { CLI_NAME, CLI_VERSION } from "./core/constants";
import {
  setExitCode,
  writeCauseEnvelope,
  writeFailureEnvelope,
} from "./core/output";
import { OperatorSocketLive } from "./core/operator-socket";
import { WorkSocketLive } from "./core/socket";

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

const cli = Command.run(rootCommand, {
  name: CLI_NAME,
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

export const browserCliArgsFromArgv = (
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined => {
  const sourceEntrypoint = argv[1]?.replaceAll("\\", "/");
  const commandIndex =
    sourceEntrypoint?.endsWith("/src/cli/main.ts") === true ? 2 : 1;
  return argv[commandIndex] === "browser"
    ? argv.slice(commandIndex + 1)
    : undefined;
};

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
