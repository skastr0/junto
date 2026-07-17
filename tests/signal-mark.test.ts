import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { identityHue, minimapFill, signalMark, signalMarkForMember } from "../src/renderer/lib/signal-mark";
import { HUE } from "../src/renderer/lib/theme";

describe("signalMark", () => {
  it("maps the severity ladder to distinct hues and symbols", () => {
    expect(signalMark("blocked").hue).toBe(HUE.crimson);
    expect(signalMark("blocked").symbol).toBe("⊗");
    expect(signalMark("attention").hue).toBe(HUE.amber);
    expect(signalMark("working").hue).toBe(HUE.cyan);
    expect(signalMark("parked").hue).toBe(HUE.violet);
    expect(signalMark("idle").kind).toBe("idle");
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

describe("minimapFill", () => {
  const agent: CanvasNode = {
    id: "a1",
    type: "text",
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    text: "agent",
    ether: { entity: { kind: "agent", name: "local:grok" } },
  };

  it("uses identity hue when idle, signal hue when elevated", () => {
    expect(minimapFill(agent, "idle")).toBe(HUE.orange); // agent kind
    expect(minimapFill(agent, "blocked")).toBe(HUE.crimson);
    expect(minimapFill(agent, "working")).toBe(HUE.cyan);
  });

  it("prefers node accent over kind for identity", () => {
    const colored = { ...agent, color: "5" };
    expect(identityHue(colored)).toBe(HUE.cyan);
    expect(minimapFill(colored, "idle")).toBe(HUE.cyan);
  });
});
