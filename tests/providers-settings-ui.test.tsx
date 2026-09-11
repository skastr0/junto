import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(html).toContain("macOS Keychain");
    expect(html).toContain("Chrome profile local storage");
    expect(html).toContain("process command lines and ports");
    expect(html.match(/aria-label="Allow [^"]+ usage access"/gu)).toHaveLength(
      NATIVE_USAGE_PROVIDERS.length,
    );
    expect(checkboxInputs(html)).toHaveLength(NATIVE_USAGE_PROVIDERS.length);
    expect(checkboxInputs(html).every((input) => !input.includes("checked"))).toBe(true);
  });

  it("renders only the sources the operator enabled as checked", () => {
    state$.settings.providers.set({ enabledSources: ["claude", "cursor"] });
    const html = render();

    expect(checkboxInputs(html).filter((input) => input.includes("checked"))).toHaveLength(2);
    expect(html).toContain("access on");
  });
});
