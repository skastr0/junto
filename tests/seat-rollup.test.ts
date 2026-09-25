import { afterEach, describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import type { ThreadHealthValue } from "../src/shared/thread-health";
import { THREAD_HEALTH_TONE, THREAD_HEALTH_VALUES } from "../src/shared/thread-health";
import { controlFromActivity, seatRollup, worseRollup } from "../src/renderer/lib/seat-rollup";
import { minimapNodeColors, seatRollupsForNodes } from "../src/renderer/lib/minimap-seat-colors";
import { applySeatAwarenessEvent, resetSeatAwareness } from "../src/renderer/lib/seat-awareness";
import { HUE, GREEN } from "../src/renderer/lib/theme";

const mark = (health: "trouble" | "waiting" | "steady" | "good", stale = false) => ({
  health,
  healthStale: stale,
  line: health,
});

describe("seatRollup order", () => {
  it("puts the declared signal first", () => {
    expect(seatRollup({ signal: "feedback", control: "attention", health: mark("trouble") })).toMatchObject({
      source: "signal",
      tone: "cyan",
    });
    expect(seatRollup({ signal: "blocked" })?.tone).toBe("crimson");
    expect(seatRollup({ signal: "escalate" })?.tone).toBe("amber");
  });

  it("puts proven attention ahead of any AI reading", () => {
    expect(seatRollup({ control: "attention", health: mark("good") })).toMatchObject({ source: "control", tone: "amber" });
    expect(seatRollup({ control: "blocked", health: mark("good") })).toMatchObject({ source: "control", tone: "crimson" });
  });

  it("paints both ends of the health spectrum over plain control state", () => {
    expect(seatRollup({ control: "working", health: mark("trouble") })).toMatchObject({ source: "health", tone: "amber" });
    expect(seatRollup({ control: "working", health: mark("good") })).toMatchObject({ source: "health", tone: "green" });
    // A health reading outranks "done": done may really be waiting on you.
    expect(seatRollup({ control: "ready", health: mark("waiting") })).toMatchObject({ source: "health", tone: "amber" });
  });

  it("falls through a steady reading to control state, and idle to nothing", () => {
    expect(seatRollup({ control: "working", health: mark("steady") })).toMatchObject({ source: "control", tone: "cyan" });
    expect(seatRollup({ control: "idle", health: mark("steady") })).toBeUndefined();
    expect(seatRollup({})).toBeUndefined();
  });

  it("never paints a health reading crimson", () => {
    for (const value of THREAD_HEALTH_VALUES as readonly ThreadHealthValue[]) {
      const rollup = seatRollup({ health: mark(THREAD_HEALTH_TONE[value]) });
      expect(rollup?.tone).not.toBe("crimson");
    }
  });

  it("carries a faded reading as stale, and a signal never", () => {
    expect(seatRollup({ health: mark("good", true)})?.stale).toBe(true);
    expect(seatRollup({ signal: "blocked", health: mark("good", true) })?.stale).toBe(false);
  });
});

describe("controlFromActivity", () => {
  it("reads proven attention through the same glyph the ring draws", () => {
    expect(controlFromActivity({ mode: "wave", tone: "amber", label: "" })).toBe("attention");
    expect(controlFromActivity({ mode: "wave", tone: "crimson", label: "" })).toBe("blocked");
    expect(controlFromActivity({ mode: "wave", tone: "cyan", label: "" })).toBe("working");
    expect(controlFromActivity({ mode: "pulse", tone: "green", label: "" })).toBe("ready");
    expect(controlFromActivity({ mode: "static", tone: "steel", label: "" })).toBe("idle");
  });
});

describe("worseRollup", () => {
  it("tints by the worst member, preferring a current reading", () => {
    const green = seatRollup({ health: mark("good") });
    const amber = seatRollup({ health: mark("trouble") });
    const blocked = seatRollup({ signal: "blocked" });
    expect(worseRollup(green, amber)).toBe(amber);
    expect(worseRollup(amber, blocked)).toBe(blocked);
    const faded = seatRollup({ health: mark("trouble", true) });
    expect(worseRollup(faded, amber)).toBe(amber);
    expect(worseRollup(undefined, green)).toBe(green);
  });
});

describe("minimapNodeColors", () => {
  const ground = "#101010";
  it("paints a seat with its rollup tone, faded when the reading is stale", () => {
    expect(minimapNodeColors(undefined, "working", seatRollup({ health: mark("good") }), ground)).toEqual({
      fill: GREEN,
      stroke: GREEN,
    });
    const stale = minimapNodeColors(undefined, undefined, seatRollup({ health: mark("trouble", true) }), ground);
    expect(stale.stroke).toBe(HUE.amber);
    expect(stale.fill).not.toBe(HUE.amber);
    expect(stale.fill).toContain("var(--color-amber)");
  });

  it("keeps severity and identity colours for everything that is not a seat", () => {
    expect(minimapNodeColors(undefined, "blocked", undefined, ground)).toMatchObject({ fill: HUE.crimson, stroke: HUE.crimson });
  });
});

describe("seatRollupsForNodes", () => {
  afterEach(() => resetSeatAwareness());

  const seat = (id: string, bindingId: string): CanvasNode => ({
    id,
    type: "text",
    text: id,
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    ether: {
      entity: { kind: "agent", name: `local:${id}` },
      terminal: { bindingId, harness: "claude", launch: { kind: "harness", argv: ["claude"] } },
    },
  });

  it("joins the signal, control and Jev stores into one rollup per seat", () => {
    const now = Date.now();
    applySeatAwarenessEvent({
      kind: "assessment",
      windowDigest: "d1",
      at: 1,
      assessment: {
        bindingId: "b-thrash",
        assessmentId: "a1",
        availability: "current",
        observedAt: now,
        activity: null,
        concerns: [],
        absences: [],
        unansweredConcerns: [],
        evidence: { digest: "d1", capturedAt: now, lines: [] },
        selectedLineId: null,
        unavailableReason: null,
        health: {
          bindingId: "b-thrash",
          value: "thrashing",
          confidence: 0.92,
          observedAt: now,
          provenance: { source: "jev", assessmentId: "a1", questionId: "health.thrashing", packVersion: "awareness-pack/2" },
          signals: [{ value: "thrashing", probability: 0.92, questionId: "health.thrashing" }],
        },
      },
    });
    const nodes = [seat("thrash", "b-thrash"), seat("busy", "b-busy"), seat("quiet", "b-quiet")];
    const rollups = seatRollupsForNodes(nodes, {
      now,
      severityByNodeId: { thrash: "working", busy: "working" },
      signalsByNodeId: {},
      bindingOf: (node) => node.ether?.terminal?.bindingId,
    });
    expect(rollups.get("thrash")).toMatchObject({ source: "health", tone: "amber", reason: "AI reads thrashing" });
    expect(rollups.get("busy")).toMatchObject({ source: "control", tone: "cyan" });
    expect(rollups.has("quiet")).toBe(false);

    // A region takes its worst member seat, as a tint, and a region with no
    // rolled-up seat keeps its own colours.
    const region = (id: string, x: number): CanvasNode =>
      ({ id, type: "group", label: id, x, y: -50, width: 600, height: 400 }) as unknown as CanvasNode;
    const tinted = seatRollupsForNodes([...nodes, region("zone", -50), region("empty", 5_000)], {
      now,
      severityByNodeId: { thrash: "working", busy: "working", zone: "working" },
      signalsByNodeId: {},
      bindingOf: (node) => node.ether?.terminal?.bindingId,
    });
    expect(tinted.get("zone")).toMatchObject({ tone: "amber", source: "health" });
    expect(tinted.has("empty")).toBe(false);
    const colors = minimapNodeColors(region("zone", -50), "working", tinted.get("zone"), "#101010");
    expect(colors.stroke).toBe(HUE.amber);
    expect(colors.fill).not.toBe(HUE.amber);
  });
});
