import { describe, expect, it } from "vitest";
import {
  GLANCE_FULL,
  GLANCE_START,
  GLANCE_VAR,
  publishRegionGlance,
  regionGlanceFontSize,
  regionGlanceOpacity,
} from "../src/renderer/lib/region-glance";

describe("regionGlanceFontSize", () => {
  it("fits the label inside the plate width", () => {
    const label = "Build floor";
    const size = regionGlanceFontSize(900, 560, label);
    expect(size * label.length * 0.68).toBeLessThanOrEqual(900);
    expect(size).toBeGreaterThan(60);
  });

  it("shrinks for long labels and grows for short ones", () => {
    const long = regionGlanceFontSize(900, 560, "Continuous integration and release");
    const short = regionGlanceFontSize(900, 560, "Ship");
    expect(long).toBeLessThan(short);
  });

  it("never outgrows the plate height", () => {
    expect(regionGlanceFontSize(4000, 200, "Ops")).toBeLessThanOrEqual(200 * 0.4);
  });

  it("keeps a floor for tiny plates", () => {
    expect(regionGlanceFontSize(40, 30, "Ops")).toBe(22);
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

  it("is a no-op without a host", () => {
    expect(publishRegionGlance(null, 0.2)).toBe(false);
  });
});
