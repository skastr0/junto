import { Layer } from "effect";
import { antigravitySource } from "./antigravity-source";
import { claudeSource } from "./claude-source";
import { codexSource } from "./codex-source";
import { copilotSource } from "./copilot-source";
import { cursorSource } from "./cursor-source";
import { devinSource } from "./devin-source";
import { grokSource } from "./grok-source";
import { hermesSource } from "./hermes-source";
import { kimiSource } from "./kimi-source";
import { ollamaSource } from "./ollama-source";
import { openrouterSource } from "./openrouter-source";
import { opencodeGoSource } from "./opencodego-source";
import { syntheticSource } from "./synthetic-source";
import { UsageSources } from "./usage-source";

// Station usage registry.
//
// Production is the native sources only. Each source is an ordered strategy
// pipeline (live credential read first, local cache / cheaper probes after)
// and every fetch is a TOTAL fail-open envelope: failures fold into
// ok:false + reason, never a throw across IPC. A missing or failing source
// degrades to an empty snapshot so the HUD hides instead of erroring.

/**
 * First-party harness readers — the production usage path. Claude plan
 * windows via OAuth, Codex limits via ChatGPT backend, Grok/Hermes session
 * tokens. Order matters for HUD paint order only; correctness never depends
 * on it.
 */
export const NATIVE_USAGE_SOURCES = [
  claudeSource,
  codexSource,
  copilotSource,
  cursorSource,
  devinSource,
  grokSource,
  hermesSource,
  kimiSource,
  ollamaSource,
  opencodeGoSource,
  openrouterSource,
  antigravitySource,
  syntheticSource,
] as const;

/** Production registry: the native strategy pipelines alone. */
export const StationUsageSourcesLive = Layer.succeed(UsageSources, [...NATIVE_USAGE_SOURCES]);
