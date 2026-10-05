import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  INTERFACE_SCALES,
  Settings,
  SettingsPatch,
  applySettingsPatch,
  defaultSettings,
  interfaceScaleOf,
} from "../src/shared/settings";
import { decodeStoredSettings, preferencesFromSettings } from "../src/main/junto/settings/state-schema";
import {
  applyInterfaceScale,
  currentInterfaceScale,
  followInterfaceScale,
  setInterfaceScale,
} from "../src/main/junto/interface-scale";

const decodePatch = Schema.decodeUnknownSync(SettingsPatch, { onExcessProperty: "error" });
const decodeSettings = Schema.decodeUnknownSync(Settings, { onExcessProperty: "error" });

const target = () => {
  const factors: number[] = [];
  let destroyed = false;
  return {
    factors,
    destroy: () => {
      destroyed = true;
    },
    isDestroyed: () => destroyed,
    setZoomFactor: (factor: number) => {
      factors.push(factor);
    },
  };
};

describe("interface size setting", () => {
  it("is 100 percent until the operator chooses, and rows written before it decode", () => {
    const settings = defaultSettings();
    expect(settings.appearance.interfaceScale).toBeUndefined();
    expect(interfaceScaleOf(settings)).toBe(100);
    expect(interfaceScaleOf(decodeStoredSettings(1, preferencesFromSettings(settings), settings.station))).toBe(100);
  });

  it("takes each offered size through a patch and keeps it through the stored row", () => {
    for (const scale of INTERFACE_SCALES) {
      const next = applySettingsPatch(defaultSettings(), decodePatch({ appearance: { interfaceScale: scale } }));
      expect(interfaceScaleOf(decodeSettings(next))).toBe(scale);
      expect(interfaceScaleOf(decodeStoredSettings(1, preferencesFromSettings(next), next.station))).toBe(scale);
    }
  });

  it("refuses a size that is not offered", () => {
    expect(() => decodePatch({ appearance: { interfaceScale: 300 } })).toThrow();
    expect(() => decodePatch({ appearance: { interfaceScale: 1.5 } })).toThrow();
  });

  it("leaves the size alone when a patch changes something else", () => {
    const large = applySettingsPatch(defaultSettings(), { appearance: { interfaceScale: 150 } });
    expect(interfaceScaleOf(applySettingsPatch(large, { appearance: { theme: "bright" } }))).toBe(150);
  });
});

describe("interface size in main", () => {
  afterEach(() => setInterfaceScale(100));

  it("applies the size in force to a window that starts following, and every change after", () => {
    setInterfaceScale(125);
    const window = target();
    const stop = followInterfaceScale(window);
    expect(window.factors).toEqual([1.25]);
    setInterfaceScale(200);
    expect(window.factors).toEqual([1.25, 2]);
    // The same size again is not a change: no second resize.
    setInterfaceScale(200);
    expect(window.factors).toEqual([1.25, 2]);
    stop();
    setInterfaceScale(90);
    expect(window.factors).toEqual([1.25, 2]);
    expect(currentInterfaceScale()).toBe(90);
  });

  it("re-applies on demand after a load, and never touches a destroyed window", () => {
    const window = target();
    followInterfaceScale(window);
    setInterfaceScale(150);
    applyInterfaceScale(window);
    expect(window.factors).toEqual([1, 1.5, 1.5]);
    window.destroy();
    setInterfaceScale(175);
    expect(window.factors).toEqual([1, 1.5, 1.5]);
  });
});
