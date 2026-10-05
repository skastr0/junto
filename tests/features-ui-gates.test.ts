import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AUDIO_ENABLED,
  FLEET_UI_ENABLED,
  USAGE_ENABLED,
} from "../src/shared/features";
import { ProvidersSettingsSection } from "../src/renderer/components/settings/ProvidersSettingsSection";
import { openFleet, prefetchFleetChunk } from "../src/renderer/lib/fleet-state";
import { playCue } from "../src/renderer/lib/sound";
import { state$ } from "../src/renderer/lib/state";

describe("ship-profile UI feature gates", () => {
  it.runIf(!FLEET_UI_ENABLED)("does not open or prefetch fleet UI while disabled", () => {
    state$.fleetOpen.set(false);
    prefetchFleetChunk();
    openFleet();
    expect(state$.fleetOpen.peek()).toBe(false);
  });

  it.runIf(!USAGE_ENABLED)("shows no usage source, credential or wording in Settings while usage is disabled", () => {
    const html = renderToStaticMarkup(createElement(ProvidersSettingsSection));
    expect(html).not.toMatch(/usage/iu);
    expect(html).not.toContain("Provider access is off by default");
    expect(html).not.toContain("settings-provider-reveal");
  });

  it.runIf(!AUDIO_ENABLED)("does not construct Web Audio while audio is disabled", () => {
    let constructed = false;
    const prior = globalThis.AudioContext;
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: class {
        constructor() {
          constructed = true;
        }
      },
    });
    try {
      playCue("blocked");
      expect(constructed).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "AudioContext", {
        configurable: true,
        value: prior,
      });
    }
  });
});
