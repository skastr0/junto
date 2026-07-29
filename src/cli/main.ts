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
  escalateCommand,
  msgCommand,
  requestCommand,
  tasksCommand,
} from "./commands/work";
import { runBrowserCli } from "../../scripts/browser-cli";
import { CLI_NAME, CLI_VERSION } from "./core/constants";
import {
  setExitCode,
  writeCauseEnvelope,
  writeFailureEnvelope,
} from "./core/output";
import { WorkSocketLive } from "./core/socket";

export const rootCommand = Command.make(CLI_NAME).pipe(
  Command.withDescription(
    "Agent protocol surface over the Vellum work plane (JSON only, daemon-first)",
  ),
  Command.withSubcommands([
    pingCommand,
    doctorCommand,
    capabilitiesCommand,
    onboardCommand,
    schemaCommand,
    examplesCommand,
    tasksCommand,
    msgCommand,
    requestCommand,
    escalateCommand,
    artifactCommand,
  ]),
);

const cli = Command.run(rootCommand, {
  name: CLI_NAME,
  version: CLI_VERSION,
});

const runtimeLayer = Layer.mergeAll(BunContext.layer, WorkSocketLive);

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

// When executed as the CLI entrypoint (bun / compiled binary).
if (import.meta.main) {
  const browserIndex = Bun.argv.findIndex(
    (argument, index) => index > 0 && argument === "browser",
  );
  if (browserIndex >= 0) {
    await runBrowserCli(Bun.argv.slice(browserIndex + 1));
  } else {
    runCli(Bun.argv).pipe(BunRuntime.runMain);
  }
}

void Cause;
