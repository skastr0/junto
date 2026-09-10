#!/usr/bin/env bun
/** Source-checkout entry for the same first-install command shipped in the CLI. */
import { BunRuntime } from "@effect/platform-bun";
import { runCli } from "../src/cli/main";

if (import.meta.main) {
  BunRuntime.runMain(runCli(["desktop-install", ...process.argv.slice(2)]));
}
