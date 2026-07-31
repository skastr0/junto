#!/usr/bin/env bun
import * as Cause from "effect/Cause";
import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
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
  BunContext.layer,
  WorkSocketLive,
  OperatorSocketLive,
);

export const runCli = (args: ReadonlyArray<string>) =>
  Effect.suspend(() => cli(args)).pipe(
    Effect.catchAll((error) =>
      setExitCode(1).pipe(Effect.zipRight(writeFailureEnvelope(undefined, error))),
    ),
    Effect.catchAllCause((cause) =>
      setExitCode(1).pipe(Effect.zipRight(writeCauseEnvelope(undefined, cause))),
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
    runCli(Bun.argv).pipe(BunRuntime.runMain);
  }
}

void Cause;
