import { Layer } from "effect";
import { claudeSource } from "./claude-source";
import { codexSource } from "./codex-source";
import { codexbarSource } from "./codexbar-source";
import { grokSource } from "./grok-source";
import { hermesSource } from "./hermes-source";
import { UsageSources } from "./usage-source";

// Station usage registry.
//
// Beta surface: **codexbar only**. Missing CLI → empty state → HUD hidden
// (fail open). No native harness polling in production until post-beta.
//
// WIP post-beta: re-enable `NATIVE_USAGE_SOURCES` by spreading them into
// `StationUsageSourcesLive` (and keep preferNativeUsageSnapshots ranking).
// Source modules stay wired for unit tests via `NativeUsageSourcesLive`.

/**
 * First-party harness readers — implemented, unit-tested, **not** on the
 * production path. Claude plan windows, Grok/Hermes session tokens, Codex
 * limits stub. Re-enable post-beta when product wants dual-source again.
 */
export const NATIVE_USAGE_SOURCES = [
  claudeSource,
  codexSource,
  grokSource,
  hermesSource,
] as const;

/** Production registry (beta): codexbar alone. */
export const StationUsageSourcesLive = Layer.succeed(UsageSources, [codexbarSource]);

/** Native-only (unit tests / post-beta experiments — not the live app). */
export const NativeUsageSourcesLive = Layer.succeed(UsageSources, [...NATIVE_USAGE_SOURCES]);
