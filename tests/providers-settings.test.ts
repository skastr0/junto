import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context, Effect, ManagedRuntime, Schema } from "effect";
import {
  MASKED_SECRET,
  PROVIDER_SECTION_KEYS,
  Settings,
  SettingsPatch,
  applySettingsPatch,
  defaultSettings,
  redactProvidersForIpc,
} from "../src/shared/settings";
import {
  applyAndValidatePatch,
  decodePatchInput,
} from "../src/main/vellum-command/settings/patch";
import {
  decodeStoredSettings,
} from "../src/main/vellum-command/settings/state-schema";
import {
  makeSettingsService,
  type SettingsServiceApi,
} from "../src/main/vellum-command/settings/service";
import { StateEngine } from "../src/main/vellum-command/state/service";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

const decodeSettingsStrict = Schema.decodeUnknownSync(Settings, {
  onExcessProperty: "error",
});
const decodePatchStrict = Schema.decodeUnknownSync(SettingsPatch, {
  onExcessProperty: "error",
});

const SECRET = "sk-super-secret-value-9f8e7d6c";
const OTHER_SECRET = "management-secret-abcdef123456";

describe("providers settings schema", () => {
  it("defaults carry no provider credentials and still decode", () => {
    const settings = defaultSettings();
    expect(settings.providers).toEqual({});
    expect(decodeSettingsStrict(settings)).toEqual(settings);
  });

  it("applySettingsPatch deep-merges provider fields without clobbering siblings", () => {
    let next = applySettingsPatch(defaultSettings(), {
      providers: { openrouter: { apiKey: SECRET } },
    });
    next = applySettingsPatch(next, {
      providers: {
        openrouter: { managementApiKey: OTHER_SECRET },
        synthetic: { apiKey: "synthetic-key" },
      },
    });
    expect(next.providers?.openrouter).toEqual({
      apiKey: SECRET,
      managementApiKey: OTHER_SECRET,
    });
    expect(next.providers?.synthetic).toEqual({ apiKey: "synthetic-key" });
    // Untouched sections stay absent.
    expect(next.providers?.kimi).toBeUndefined();
  });

  it("an empty string clears a field and a masked echo is a no-op", () => {
    let next = applySettingsPatch(defaultSettings(), {
      providers: { cursor: { cookieHeader: SECRET } },
    });
    // Echoing the mask back must not overwrite or corrupt the stored secret.
    next = applySettingsPatch(next, {
      providers: { cursor: { cookieHeader: MASKED_SECRET } },
    });
    expect(next.providers?.cursor?.cookieHeader).toBe(SECRET);
    next = applySettingsPatch(next, {
      providers: { cursor: { cookieHeader: "" } },
    });
    expect(next.providers?.cursor).toEqual({});
  });

  it("values are trimmed on write", () => {
    const next = applySettingsPatch(defaultSettings(), {
      providers: { kimi: { authToken: `  token-123 \n` } },
    });
    expect(next.providers?.kimi?.authToken).toBe("token-123");
  });

  it("round-trips through the patch decoder and the full aggregate decoder", () => {
    const raw = {
      providers: {
        devin: { bearerToken: SECRET, organizationId: "org/acme" },
        ollama: { sessionCookie: "cookie" },
      },
    };
    const patch = decodePatchStrict(raw);
    const merged = applyAndValidatePatch(defaultSettings(), patch);
    if (merged._tag === "Failure") throw merged.failure;
    expect(merged.success.providers?.devin).toEqual({
      bearerToken: SECRET,
      organizationId: "org/acme",
    });
  });

  it("rejects unknown provider sections and oversized secrets", () => {
    expect(() =>
      decodePatchStrict({ providers: { unknownProvider: { apiKey: "x" } } }),
    ).toThrow();
    expect(() =>
      decodePatchStrict({
        providers: { openrouter: { apiKey: "x".repeat(9000) } },
      }),
    ).toThrow();
  });

  it("redactProvidersForIpc masks every secret field and keeps non-secrets", () => {
    const settings = applySettingsPatch(defaultSettings(), {
      providers: {
        openrouter: { apiKey: SECRET, managementApiKey: OTHER_SECRET },
        synthetic: { apiKey: "synthetic-key" },
        kimi: { authToken: "web-token", apiKey: "api-key" },
        devin: { bearerToken: SECRET, organizationId: "organizations/abc" },
        opencodeGo: { apiKey: "zen-key" },
        copilot: { token: "gh-token" },
        ollama: { sessionCookie: "cookie", apiKey: "okey" },
        cursor: { cookieHeader: "Cookie: session=xyz" },
      },
    }).providers!;
    const redactedSection = redactProvidersForIpc({
      ...defaultSettings(),
      providers: settings,
    }).providers!;

    for (const key of PROVIDER_SECTION_KEYS) {
      const section = redactedSection[key] as Record<string, string> | undefined;
      if (section === undefined) continue;
      for (const [field, value] of Object.entries(section)) {
        if (key === "devin" && field === "organizationId") continue;
        expect(value).toBe(MASKED_SECRET);
      }
    }
    // Non-secret field passes through.
    expect(redactedSection.devin?.organizationId).toBe("organizations/abc");
    // The serialized projection never carries a raw secret.
    const serialized = JSON.stringify(redactedSection);
    for (const secret of [
      SECRET,
      OTHER_SECRET,
      "synthetic-key",
      "web-token",
      "api-key",
      "zen-key",
      "gh-token",
      "Cookie: session=xyz",
    ]) {
      expect(serialized.includes(secret)).toBe(false);
    }
  });

  it("decodeStoredSettings admits rows written before the section existed", () => {
    const current = defaultSettings();
    const legacyPreferences = {
      appearance: current.appearance,
      canvas: current.canvas,
      kernel: current.kernel,
      browser: current.browser,
      advanced: current.advanced,
      audio: current.audio,
      fleet: current.fleet,
      harnesses: current.harnesses,
    };
    const restored = decodeStoredSettings(1, legacyPreferences, {
      role: "",
      hostId: "local",
      supervisedPreferred: false,
    });
    expect(restored.providers).toEqual({});
    expect(() =>
      Schema.decodeUnknownSync(Settings, { onExcessProperty: "error" })(restored),
    ).not.toThrow();
  });
});

type Harness = {
  readonly service: SettingsServiceApi;
  readonly state: Context.Service.Shape<typeof StateEngine>;
  readonly close: () => Promise<void>;
};

describe("providers settings service persistence", () => {
  let root = "";
  let databasePath = "";
  let active: Harness | undefined;

  afterEach(async () => {
    const current = active;
    active = undefined;
    await current?.close();
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  const openService = async (): Promise<Harness> => {
    if (root === "") {
      root = await mkdtemp(join(tmpdir(), "vellum-providers-settings-"));
      databasePath = join(root, "state", "vellum-command.db");
    }
    const runtime = ManagedRuntime.make(makeStateEngineLive(databasePath));
    const state = await runtime.runPromise(StateEngine);
    const service = await run(makeSettingsService(state));
    return {
      service,
      state,
      close: () => runtime.dispose(),
    };
  };

  it("persists provider credentials through the existing settings row and repatches them", async () => {
    const harness = await openService();
    try {
      const patched = await run(
        harness.service.patch({
          providers: { openrouter: { apiKey: SECRET } },
        }),
      );
      expect(patched.providers?.openrouter?.apiKey).toBe(SECRET);

      // A fresh service over the same database sees the stored credential.
      await harness.close();
      const reopened = await openService();
      const reread = await run(reopened.service.get);
      expect(reread.providers?.openrouter?.apiKey).toBe(SECRET);

      // Clearing works too.
      const cleared = await run(
        reopened.service.patch({ providers: { openrouter: { apiKey: "" } } }),
      );
      expect(cleared.providers?.openrouter).toEqual({});
      await reopened.close();
    } finally {
      if (active) {
        await active.close();
        active = undefined;
      }
    }
  });
});
