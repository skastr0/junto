import { describe, expect, it } from "vitest";
import {
  AUDIO_ENABLED,
  FLEET_UI_ENABLED,
} from "../src/shared/features";
import { openFleet, prefetchFleetChunk } from "../src/renderer/lib/fleet-state";
import { playAlert } from "../src/renderer/lib/sfx";
import { state$ } from "../src/renderer/lib/state";

describe("ship-profile UI feature gates", () => {
  it.runIf(!FLEET_UI_ENABLED)("does not open or prefetch fleet UI while disabled", () => {
    state$.fleetOpen.set(false);
    prefetchFleetChunk();
    openFleet();
    expect(state$.fleetOpen.peek()).toBe(false);
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
      playAlert("blocked");
      expect(constructed).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "AudioContext", {
        configurable: true,
        value: prior,
      });
    }
  });
});
