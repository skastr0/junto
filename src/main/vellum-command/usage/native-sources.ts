import { Context, Effect, Layer } from "effect";
import { antigravitySource } from "./antigravity-source";
import { claudeSource } from "./claude-source";
import { codexSource } from "./codex-source";
import { makeCopilotSource } from "./copilot-source";
import { makeCursorSource } from "./cursor-source";
import { makeDevinSource } from "./devin-source";
import { grokSource } from "./grok-source";
import { hermesSource } from "./hermes-source";
import { makeKimiSource } from "./kimi-source";
import { makeOllamaSource } from "./ollama-source";
import { makeOpenRouterSource } from "./openrouter-source";
import { makeOpencodeGoSource } from "./opencodego-source";
import { makeSyntheticSource } from "./synthetic-source";
import { OperatorProviderCredentials } from "./operator-credentials";
import type { UsageSource } from "./usage-source";
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
 *
 * Sources with an operator-configurable credential tier (copilot, cursor,
 * devin, kimi, ollama, opencode-go, openrouter, synthetic) are built over the
 * OperatorProviderCredentials reader so Settings > Providers sits FIRST in
 * every resolution chain: operator setting -> env var -> credential files.
 */
type OperatorProviderCredentialsShape = Context.Service.Shape<
  typeof OperatorProviderCredentials
>;

export const makeNativeUsageSources = (
  operator: OperatorProviderCredentialsShape,
): ReadonlyArray<UsageSource> => {
  const readOperator = operator.read;
  return [
    claudeSource,
    codexSource,
    makeCopilotSource(() => readOperator().copilot),
    makeCursorSource(() => readOperator().cursor),
    makeDevinSource(() => readOperator().devin),
    grokSource,
    hermesSource,
    makeKimiSource(() => readOperator().kimi),
    makeOllamaSource(() => readOperator().ollama),
    makeOpencodeGoSource(() => readOperator().opencodeGo),
    makeOpenRouterSource(() => readOperator().openrouter),
    antigravitySource,
    makeSyntheticSource({ readOperator: () => readOperator().synthetic }),
  ];
};

/** Production registry: the native strategy pipelines alone. */
export const StationUsageSourcesLive = Layer.effect(
  UsageSources,
  Effect.gen(function* () {
    const operator = yield* OperatorProviderCredentials;
    return [...makeNativeUsageSources(operator)];
  }),
);
