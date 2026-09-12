import { describe, expect, it } from "vitest";
import {
  persistableProviders,
  retainUnmigratedProviderSecrets,
} from "../src/main/vellum-command/credentials/redact";

describe("retainUnmigratedProviderSecrets", () => {
  it("keeps non-section keys intact while merging sections", () => {
    // Regression: spreading every key of `next` into a per-section record
    // turned the enabledSources ARRAY into a plain object, and the next
    // decode of the stored row failed closed.
    const next = {
      enabledSources: ["openrouter" as const],
      openrouter: { managementApiKey: "mk" },
    };
    const merged = retainUnmigratedProviderSecrets(
      { openrouter: { apiKey: "sk-stored" } },
      next,
      new Set(),
    );
    expect(merged.enabledSources).toEqual(["openrouter"]);
    expect(merged.openrouter).toEqual({
      managementApiKey: "mk",
      apiKey: "sk-stored",
    });
  });

  it("honors migrated slots and preserves non-section scalars", () => {
    const merged = retainUnmigratedProviderSecrets(
      { openrouter: { apiKey: "sk-stored" } },
      { enabledSources: [], hermesHostSnapshots: true, openrouter: {} },
      new Set(["openrouter/apiKey"]),
    );
    expect(merged.enabledSources).toEqual([]);
    expect(merged.hermesHostSnapshots).toBe(true);
    expect(merged.openrouter).toEqual({});
  });
});

describe("persistableProviders", () => {
  it("retains unmigrated secrets without corrupting enabledSources", () => {
    // managementApiKey is a secret field: stripped from `next` by design, and
    // only the stored plaintext (unmigrated) is retained on disk.
    const out = persistableProviders(
      { enabledSources: ["openrouter"], openrouter: { managementApiKey: "mk" } },
      { retainHistorical: { openrouter: { apiKey: "sk-stored" } } },
    );
    expect(out.enabledSources).toEqual(["openrouter"]);
    expect(out.openrouter).toEqual({ apiKey: "sk-stored" });
  });
});
