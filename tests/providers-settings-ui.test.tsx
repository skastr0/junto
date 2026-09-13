import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { HERMES_INTEGRATION_ENABLED } from "@shared/features";
import { defaultSettings } from "@shared/settings";
import { NATIVE_USAGE_PROVIDERS } from "@shared/usage";
import { ProvidersSettingsSection } from "../src/renderer/components/settings/ProvidersSettingsSection";
import { state$ } from "../src/renderer/lib/state";

const render = (): string => renderToStaticMarkup(<ProvidersSettingsSection />);

const checkboxInputs = (html: string): ReadonlyArray<string> =>
  html.match(/<input type="checkbox"[^>]*>/gu) ?? [];

afterEach(() => state$.settings.set(defaultSettings()));

describe("provider access settings", () => {
  it("shows every source as explicit opt-in and discloses sensitive access", () => {
    const html = render();

    expect(html).toContain("Provider access is off by default");
    expect(html).toContain("Usage sources refresh every five minutes");
    expect(html).toContain("macOS Keychain");
    expect(html).toContain("Chrome profile local storage");
    expect(html).toContain("process command lines and ports");
    expect(html).toContain("This does not run hermes CLI commands");
    expect(html.match(/aria-label="Allow [^"]+ usage access"/gu)).toHaveLength(
      NATIVE_USAGE_PROVIDERS.length,
    );
    expect(checkboxInputs(html)).toHaveLength(
      NATIVE_USAGE_PROVIDERS.length + (HERMES_INTEGRATION_ENABLED ? 1 : 0),
    );
    expect(checkboxInputs(html).every((input) => !input.includes("checked"))).toBe(true);
    if (HERMES_INTEGRATION_ENABLED) {
      expect(html).toContain("Allow Hermes host snapshot access");
      expect(html).toContain("enrolled-host SSH");
    }
  });

  it("renders only the sources the operator enabled as checked", () => {
    state$.settings.providers.set({ enabledSources: ["claude", "cursor"] });
    const html = render();

    expect(checkboxInputs(html).filter((input) => input.includes("checked"))).toHaveLength(2);
    expect(html).toContain("access on");
  });

  it("offers write-only OpenAI credentials and explicit per-call limits", () => {
    state$.settings.providers.set({ openai: { apiKeyConfigured: true } });
    const html = render();
    expect(html).toContain('aria-label="GPT-Live settings"');
    expect(html).toContain("API key configured");
    expect(html).toContain("A call starts only when you choose Start live conversation");
    expect(html).toContain('aria-label="Live backend model"');
    expect(html).toContain('aria-label="Maximum call minutes"');
    expect(html).toContain('aria-label="Voice limit per call in USD"');
    expect(html).toContain("Backend token charges are separate");
    expect(html).toContain("credential vault");
    expect(html).not.toContain("Reveal OpenAI API key");
  });
});
