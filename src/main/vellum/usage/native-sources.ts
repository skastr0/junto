import { Layer } from "effect";
import { claudeSource } from "./claude-source";
import { codexSource } from "./codex-source";
import { codexbarSource } from "./codexbar-source";
import { grokSource } from "./grok-source";
import { hermesSource } from "./hermes-source";
import { UsageSources } from "./usage-source";

// Station usage registry (Phase 8):
//   native first — Claude limits, Grok/Hermes tokens; Codex limits stubbed
//   codexbar optional — other providers / enrich when the CLI is on PATH
//
// No hard dependency on Codex Bar. Native sources work on Linux and macOS
// via harness home files (honors sandboxed HOME for e2e).

export const NATIVE_USAGE_SOURCES = [
  claudeSource,
  codexSource,
  grokSource,
  hermesSource,
] as const;

/** Full production registry: native + optional codexbar. */
export const StationUsageSourcesLive = Layer.succeed(UsageSources, [
  ...NATIVE_USAGE_SOURCES,
  codexbarSource,
]);

/** Native-only (tests / environments without codexbar). */
export const NativeUsageSourcesLive = Layer.succeed(UsageSources, [...NATIVE_USAGE_SOURCES]);
