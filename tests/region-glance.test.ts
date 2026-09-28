import { describe, expect, it } from "vitest";
import {
  GLANCE_FULL,
  GLANCE_START,
  GLANCE_SUB_VAR,
  GLANCE_VAR,
  publishRegionGlance,
  regionGlanceOpacity,
  regionTallyParts,
  SUBREGION_BAND,
  subregionGlanceOpacity,
  type RegionTally,
} from "../src/renderer/lib/region-glance";

describe("subregionGlanceOpacity", () => {
  it("stays silent while cards inside the nested plate are readable", () => {
    expect(subregionGlanceOpacity(1.4)).toBe(0);
    expect(subregionGlanceOpacity(SUBREGION_BAND.rise)).toBe(0);
  });

  it("inks fully across its own band", () => {
    expect(subregionGlanceOpacity(SUBREGION_BAND.peak)).toBe(1);
    expect(subregionGlanceOpacity(0.78)).toBe(1);
    expect(subregionGlanceOpacity(SUBREGION_BAND.hold)).toBe(1);
  });

  it("stays inked all the way out, alongside the outer band", () => {
    // Names sit in clear ground (region-name-slot.ts), so a nested name and
    // its parent's may print together.
    expect(subregionGlanceOpacity(GLANCE_START)).toBe(1);
    expect(subregionGlanceOpacity(0.26)).toBe(1);
    expect(subregionGlanceOpacity(0.1)).toBe(1);
    expect(regionGlanceOpacity(0.26)).toBe(1);
  });

  it("treats a missing zoom as readable", () => {
    expect(subregionGlanceOpacity(Number.NaN)).toBe(0);
  });
});

describe("regionGlanceOpacity", () => {
  it("stays silent while cards are readable", () => {
    expect(regionGlanceOpacity(1)).toBe(0);
    expect(regionGlanceOpacity(2.5)).toBe(0);
    expect(regionGlanceOpacity(GLANCE_START)).toBe(0);
  });

  it("inks fully once the camera is past the far threshold", () => {
    expect(regionGlanceOpacity(GLANCE_FULL)).toBe(1);
    expect(regionGlanceOpacity(0.15)).toBe(1);
  });

  it("ramps monotonically between the thresholds", () => {
    const mid = regionGlanceOpacity((GLANCE_START + GLANCE_FULL) / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(regionGlanceOpacity(0.4)).toBeGreaterThan(regionGlanceOpacity(0.55));
  });

  it("treats a missing zoom as readable", () => {
    expect(regionGlanceOpacity(Number.NaN)).toBe(0);
  });
});

describe("publishRegionGlance", () => {
  const host = (): HTMLElement => {
    const el = { style: new Map<string, string>() };
    return {
      style: {
        getPropertyValue: (name: string) => el.style.get(name) ?? "",
        setProperty: (name: string, value: string) => el.style.set(name, value),
      },
    } as unknown as HTMLElement;
  };

  it("writes the property once per distinct value", () => {
    const el = host();
    expect(publishRegionGlance(el, 0.2)).toBe(true);
    expect(el.style.getPropertyValue(GLANCE_VAR)).toBe("1.00");
    expect(publishRegionGlance(el, 0.18)).toBe(false);
    expect(publishRegionGlance(el, 1.2)).toBe(true);
    expect(el.style.getPropertyValue(GLANCE_VAR)).toBe("0");
  });

  it("publishes the nested band alongside the outer one", () => {
    const el = host();
    publishRegionGlance(el, 0.8);
    expect(el.style.getPropertyValue(GLANCE_SUB_VAR)).toBe("1.00");
    expect(el.style.getPropertyValue(GLANCE_VAR)).toBe("0");
    // Moving inside the nested band alone still counts as a change.
    expect(publishRegionGlance(el, 0.2)).toBe(true);
    expect(el.style.getPropertyValue(GLANCE_SUB_VAR)).toBe("1.00");
    expect(el.style.getPropertyValue(GLANCE_VAR)).toBe("1.00");
  });

  it("is a no-op without a host", () => {
    expect(publishRegionGlance(null, 0.2)).toBe(false);
  });
});

describe("regionTallyParts", () => {
  const tally = (over: Partial<RegionTally>): RegionTally => ({
    total: 0, blocked: 0, attention: 0, working: 0, ready: 0, ...over,
  });

  it("says nothing for an empty or unknown region", () => {
    expect(regionTallyParts(undefined)).toEqual([]);
    expect(regionTallyParts(tally({}))).toEqual([]);
  });

  it("names only the states present, worst first", () => {
    expect(regionTallyParts(tally({ total: 9, working: 3, blocked: 1, ready: 2 }))).toEqual([
      { tone: "crimson", text: "1 blocked" },
      { tone: "cyan", text: "3 working" },
      { tone: "green", text: "2 done" },
    ]);
  });

  it("reads a quiet region as idle", () => {
    expect(regionTallyParts(tally({ total: 4 }))).toEqual([{ tone: "steel", text: "4 idle" }]);
    expect(regionTallyParts(tally({ total: 1 }))).toEqual([{ tone: "steel", text: "1 idle" }]);
  });
});
