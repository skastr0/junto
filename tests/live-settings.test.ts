import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  SettingsPatch,
  applySettingsPatch,
  defaultLive,
  defaultSettings,
  liveCallLimitSeconds,
  liveSettings,
  redactProvidersForIpc,
} from "../src/shared/settings";
import { MemoryCredentialStore } from "../src/main/junto/credentials/store";
import { makeSettingsService } from "../src/main/junto/settings/service";
import { decodeStoredSettings, preferencesFromSettings } from "../src/main/junto/settings/state-schema";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { StateEngine } from "../src/main/junto/state/service";

const decodePatch = Schema.decodeUnknownSync(SettingsPatch, { onExcessProperty: "error" });
const SECRET = "sk-openai-live-test-only";

describe("Live provider preferences", () => {
  it("decodes pre-Live rows without creating call or microphone authority", () => {
    const settings = defaultSettings();
    const { live: _live, ...prefs } = preferencesFromSettings(settings);
    const decoded = decodeStoredSettings(1, prefs, settings.station);
    expect(liveSettings(decoded)).toEqual(defaultLive());
    expect(Object.keys(liveSettings(decoded)).sort()).toEqual([
      "backendModel", "maxCallMinutes", "maxVoiceCostUsd",
    ]);
  });

  it("bounds call duration and voice estimate while allowing independent backend selection", () => {
    const next = applySettingsPatch(defaultSettings(), decodePatch({
      live: { backendModel: "gpt-5.4-mini", maxCallMinutes: 20, maxVoiceCostUsd: 0.1 },
    }));
    expect(liveSettings(next).backendModel).toBe("gpt-5.4-mini");
    expect(liveCallLimitSeconds(liveSettings(next))).toBe(120);
    expect(liveCallLimitSeconds({ ...defaultLive(), maxCallMinutes: 1 })).toBe(60);
    for (const live of [
      { maxCallMinutes: 0 }, { maxCallMinutes: 1.5 }, { maxCallMinutes: 121 },
      { maxVoiceCostUsd: 0 }, { maxVoiceCostUsd: Infinity },
      { backendModel: "" }, { backendModel: "model\nAuthorization: secret" },
      { microphoneEnabled: true },
    ]) expect(() => decodePatch({ live })).toThrow();
  });

  it("projects only OpenAI configuration presence and rejects forged presence patches", () => {
    const internal = applySettingsPatch(defaultSettings(), {
      providers: { openai: { apiKey: SECRET } },
    });
    const projected = redactProvidersForIpc(internal);
    expect(projected.providers?.openai).toEqual({ apiKeyConfigured: true });
    expect(JSON.stringify(projected)).not.toContain(SECRET);
    expect(redactProvidersForIpc(projected)).toEqual(projected);
    expect(() => decodePatch({ providers: { openai: { apiKeyConfigured: true } } })).toThrow();
    const persisted = preferencesFromSettings(projected);
    expect(persisted.providers?.openai).toBeUndefined();
  });

  it("keeps the OpenAI key in the existing vault across preference edits, rotation, and resets", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-live-settings-"));
    const path = join(root, "junto.db");
    const vault = new MemoryCredentialStore();
    const runtime = ManagedRuntime.make(makeStateEngineLive(path));
    try {
      const engine = await runtime.runPromise(StateEngine);
      const service = await Effect.runPromise(makeSettingsService(engine, { credentials: vault }));
      const broadcasts: unknown[] = [];
      const unsubscribe = service.subscribe((value) => broadcasts.push(value));
      const saved = await Effect.runPromise(service.patch({
        providers: { openai: { apiKey: SECRET } },
        live: { backendModel: "gpt-5.4-mini", maxCallMinutes: 10 },
      }));
      expect(saved.providers?.openai).toEqual({ apiKeyConfigured: true });
      expect((await Effect.runPromise(service.resolveProviders)).openai?.apiKey).toBe(SECRET);
      expect(JSON.stringify(broadcasts)).not.toContain(SECRET);
      const inspect = () => Effect.runPromise(engine.read("test.live-settings", (reader) => ({
        body: reader.get<{ body: string }>("SELECT body FROM settings_preferences WHERE singleton = 1")?.body,
        binding: reader.get<{ slot: string }>("SELECT slot FROM openai_credential_bindings WHERE lifecycle = 'active'"),
      })));
      expect((await inspect()).body).not.toContain(SECRET);
      expect((await inspect()).body).not.toContain("apiKeyConfigured");
      expect((await inspect()).binding?.slot).toBe("openai/apiKey");
      await Effect.runPromise(service.patch({ live: { maxVoiceCostUsd: 0.2 } }));
      const reread = await Effect.runPromise(service.get);
      expect(liveSettings(reread)).toEqual({ backendModel: "gpt-5.4-mini", maxCallMinutes: 10, maxVoiceCostUsd: 0.2 });
      await Effect.runPromise(service.reset("live"));
      expect(liveSettings(await Effect.runPromise(service.get))).toEqual(defaultLive());
      expect((await Effect.runPromise(service.resolveProviders)).openai?.apiKey).toBe(SECRET);
      await Effect.runPromise(service.patch({ providers: { openai: { apiKey: "sk-replacement" } } }));
      expect((await Effect.runPromise(service.resolveProviders)).openai?.apiKey).toBe("sk-replacement");
      expect(vault.listIds()).toHaveLength(1);
      await Effect.runPromise(service.reset("providers"));
      expect((await Effect.runPromise(service.get)).providers?.openai).toBeUndefined();
      expect((await Effect.runPromise(service.resolveProviders)).openai).toBeUndefined();
      expect(vault.listIds()).toEqual([]);
      expect((await inspect()).binding).toBeUndefined();
      unsubscribe();
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
