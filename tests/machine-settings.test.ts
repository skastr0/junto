import { describe, expect, test } from "vitest";
import { machineProvidersOf } from "../src/shared/machine-settings";
import { defaultSettings } from "../src/shared/settings";

describe("a machine's providers", () => {
  test("carry whether a credential is set, never its value", () => {
    const settings = {
      ...defaultSettings(),
      providers: { enabledSources: ["openrouter" as const], openrouter: { apiKey: "sk-or-v1-secret" } },
    };
    const answer = machineProvidersOf(settings, "desk");
    expect(answer.credentials.openrouter).toEqual({ apiKey: true, managementApiKey: false });
    expect(JSON.stringify(answer)).not.toContain("sk-or-v1-secret");
    expect(answer.enabledSources).toEqual(["openrouter"]);
  });

  test("count a vault-backed secret as set", () => {
    const settings = { ...defaultSettings(), providers: { openai: { apiKeyConfigured: true } } };
    expect(machineProvidersOf(settings, "desk").credentials.openai).toEqual({ apiKey: true });
  });
});
