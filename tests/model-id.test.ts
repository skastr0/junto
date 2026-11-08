/**
 * The model id and label shapes, against what live harnesses list. The cases
 * below are the 46 ids and labels this machine's harnesses listed on
 * 2026-10-17 that the first, narrower patterns refused.
 */
import { describe, expect, it } from "vitest";
import { isModelId, isModelLabel } from "../src/shared/model-id";
import { NATIVE_SETTINGS } from "../src/shared/harness-domain/native-catalogue";

/** Claude's context-window ids and OpenRouter's latest aliases. */
const LIVE_IDS = [
  "claude-fable-5-1[1m]",
  "fable[1m]",
  "openrouter/~anthropic/claude-fable-latest",
  "openrouter/~anthropic/claude-haiku-latest",
  "openrouter/~anthropic/claude-opus-latest",
  "openrouter/~anthropic/claude-sonnet-latest",
  "openrouter/~deepseek/deepseek-flash-latest",
  "openrouter/~deepseek/deepseek-pro-latest",
  "openrouter/~deepseek/deepseek-v4-flash-latest",
  "openrouter/~google/gemini-flash-latest",
  "openrouter/~google/gemini-pro-latest",
  "openrouter/~moonshotai/kimi-latest",
  "openrouter/~openai/gpt-astra-latest",
  "openrouter/~openai/gpt-luna-latest",
  "openrouter/~openai/gpt-mini-latest",
  "openrouter/~openai/gpt-sol-latest",
  "openrouter/~openai/gpt-terra-latest",
  "openrouter/~unbiased/pareto-latest",
  "openrouter/~x-ai/grok-latest",
  "openrouter/~z-ai/glm-flash-latest",
  "openrouter/~z-ai/glm-latest",
  "opus[1m]",
  "sonnet[1m]",
];

const LIVE_LABELS = [
  "~anthropic/claude-fable-latest",
  "~anthropic/claude-haiku-latest",
  "~anthropic/claude-opus-latest",
  "~anthropic/claude-sonnet-latest",
  "~deepseek/deepseek-flash-latest",
  "~deepseek/deepseek-pro-latest",
  "~deepseek/deepseek-v4-flash-latest",
  "~google/gemini-flash-latest",
  "~google/gemini-pro-latest",
  "~moonshotai/kimi-latest",
  "~openai/gpt-astra-latest",
  "~openai/gpt-luna-latest",
  "~openai/gpt-mini-latest",
  "~openai/gpt-sol-latest",
  "~openai/gpt-terra-latest",
  "~unbiased/pareto-latest",
  "~x-ai/grok-latest",
  "~z-ai/glm-flash-latest",
  "~z-ai/glm-latest",
];

/** Devin lists these Grok labels with trailing zero-width spaces. */
const ZERO_WIDTH_LABELS = [
  "Grok 4.7  Extra High Fast\u200b\u200b",
  "Grok 4.7  High Fast\u200b\u200b",
  "Grok 4.7  Low Fast\u200b\u200b",
  "Grok 4.7  Medium Fast\u200b\u200b",
];

describe("model ids and labels", () => {
  it("admit every live id and label", () => {
    for (const id of LIVE_IDS) expect(isModelId(id), id).toBe(true);
    for (const label of LIVE_LABELS) expect(isModelLabel(label), label).toBe(true);
    // An id is always a valid label, so a refused label can be shown as its id.
    for (const id of LIVE_IDS) expect(isModelLabel(id.slice(0, 80)), id).toBe(true);
  });

  it("refuse quotes, spaces, angle brackets, controls, bidi and zero-width characters", () => {
    for (const id of ['opus"', "a b", "<x>", "x\u202e", "$(id)", "a\nb", "", "x".repeat(201)]) {
      expect(isModelId(id), JSON.stringify(id)).toBe(false);
    }
    for (const label of [...ZERO_WIDTH_LABELS, 'say "hi"', "<b>x</b>", "x\u202e", "a\nb", "", "x".repeat(81)]) {
      expect(isModelLabel(label), JSON.stringify(label)).toBe(false);
    }
  });

  it("holds every native config model value to the id shape", () => {
    const models = NATIVE_SETTINGS.filter((spec) => spec.param === "model");
    expect(models.length).toBeGreaterThan(0);
    for (const spec of models) {
      expect(spec.value.kind === "string" && spec.value.format, `${spec.harness} ${spec.key}`).toBe("modelId");
    }
  });
});
