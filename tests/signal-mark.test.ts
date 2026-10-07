import { identityHueOf } from "../src/renderer/lib/signal-mark";
import { note, region, seat } from "./support/model-nodes";
import { describe, expect, it } from "vitest";
import { signalMark, signalMarkForMember } from "../src/renderer/lib/signal-mark";
import { GREEN, HUE, withAlpha } from "../src/renderer/lib/theme";

describe("signalMark", () => {
  it("maps the severity ladder to distinct hues and symbols", () => {
    expect(signalMark("blocked").hue).toBe(HUE.crimson);
    expect(signalMark("blocked").symbol).toBe("⊗");
    expect(signalMark("attention").hue).toBe(HUE.amber);
    expect(signalMark("working").hue).toBe(HUE.cyan);
    expect(signalMark("ready").hue).toBe(GREEN);
    expect(signalMark("ready").symbol).toBe("✓");
    expect(signalMark("ready").mode).toBe("pulse");
    expect(signalMark("idle").kind).toBe("idle");
    expect(signalMark("idle").symbol).toBe("○");
  });

  it("labels a ready member as finished work waiting to be read", () => {
    const mark = signalMarkForMember({ severity: "ready", reasons: ["activity:ready"] });
    expect(mark.kind).toBe("ready");
    expect(mark.label).toBe("ready to read");
  });

  it("refines labels from rollup reasons without changing severity", () => {
    const mark = signalMarkForMember({
      severity: "attention",
      reasons: ["permission:pending", "flag:attention"],
    });
    expect(mark.kind).toBe("attention");
    expect(mark.label).toBe("awaiting permission");
    expect(mark.symbol).toBe("?");
  });
});

describe("identity hue of a model node", () => {
  it("is the node's own colour first, then its kind's, a quiet steel for a region, amber otherwise", () => {
    const seatNode = seat("a");
    // accentColor returns CSS variable references so they resolve against the
    // active theme mode (dark/bright) rather than being frozen to dark hexes.
    expect(identityHueOf({ ...seatNode, color: "5" as never })).toBe("var(--color-cyan)");
    expect(identityHueOf(seatNode)).toBe(HUE.orange);
    expect(identityHueOf(note("n"))).toBe(HUE.amber);
    const zone = region("r", { x: 0, y: 0, width: 400, height: 300 });
    expect(identityHueOf(zone)).toBe(withAlpha(HUE.steel, 0.45));
    expect(identityHueOf(undefined)).toBe(HUE.steel);
  });
});
