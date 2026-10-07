import { identityHueOf } from "../src/renderer/lib/signal-mark";
import { nodeToDocument } from "../src/shared/model/from-document";
import { note, region, seat } from "./support/model-nodes";
import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { identityHue, minimapFill, signalMark, signalMarkForMember } from "../src/renderer/lib/signal-mark";
import { GREEN, HUE } from "../src/renderer/lib/theme";

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
    expect(minimapFill(agent, "ready")).toBe(GREEN);
  });

  it("prefers node accent over kind for identity", () => {
    const colored = { ...agent, color: "5" };
    // accentColor returns CSS variable references so they resolve against the
    // active theme mode (dark/bright) rather than being frozen to dark hexes.
    expect(identityHue(colored)).toBe("var(--color-cyan)");
    expect(minimapFill(colored, "idle")).toBe("var(--color-cyan)");
  });
});

describe("identity hue of a model node", () => {
  it("is the node's own colour first, then its kind's, a quiet steel for a region, amber otherwise", () => {
    const seatNode = seat("a");
    expect(identityHueOf({ ...seatNode, color: "5" as never })).toBe("var(--color-cyan)");
    // The same answer the document form gives for the same seat.
    expect(identityHueOf(seatNode)).toBe(identityHue(nodeToDocument(seatNode)));
    expect(identityHueOf(note("n"))).toBe(identityHue(nodeToDocument(note("n"))));
    const zone = region("r", { x: 0, y: 0, width: 400, height: 300 });
    expect(identityHueOf(zone)).toBe(identityHue(nodeToDocument(zone)));
    expect(identityHueOf(undefined)).toBe(identityHue(undefined));
  });
});
