import { describe, expect, it } from "vitest";
import type { AgentSignal } from "../src/shared/agent-signals";
import {
  orderSignals,
  signalOutcomeLabel,
  summarizeSeatSignals,
} from "../src/renderer/lib/agent-signals-view";
import { sectionOpen } from "../src/renderer/lib/sidebar-sections";
import { placeBesideRect } from "../src/renderer/lib/menu-placement";

const signal = (over: Partial<AgentSignal> & Pick<AgentSignal, "signalId">): AgentSignal => ({
  canvasName: "main",
  nodeId: "seat",
  kind: "feedback",
  text: "Review the draft",
  createdAt: 1_000,
  state: "open",
  ...over,
});

describe("orderSignals", () => {
  it("puts open first, worst kind first, newest first; closed by closure time", () => {
    const ordered = orderSignals([
      signal({ signalId: "closed-old", state: "answered", closedAt: 5_000 }),
      signal({ signalId: "feedback", kind: "feedback", createdAt: 9_000 }),
      signal({ signalId: "escalate-old", kind: "escalate", createdAt: 2_000 }),
      signal({ signalId: "blocked", kind: "blocked", createdAt: 1_000 }),
      signal({ signalId: "escalate-new", kind: "escalate", createdAt: 3_000 }),
      signal({ signalId: "closed-new", state: "dismissed", closedAt: 8_000 }),
    ]);
    expect(ordered.map((s) => s.signalId)).toEqual([
      "blocked",
      "escalate-new",
      "escalate-old",
      "feedback",
      "closed-new",
      "closed-old",
    ]);
  });
});

describe("summarizeSeatSignals", () => {
  it("keeps one seat on one canvas and reports the worst open kind", () => {
    const summary = summarizeSeatSignals(
      [
        signal({ signalId: "a", kind: "escalate" }),
        signal({ signalId: "b", kind: "feedback", state: "answered" }),
        signal({ signalId: "other-seat", nodeId: "else", kind: "blocked" }),
        signal({ signalId: "other-canvas", canvasName: "b", kind: "blocked" }),
      ],
      "main",
      "seat",
    );
    expect(summary.signals.map((s) => s.signalId)).toEqual(["a", "b"]);
    expect(summary.openCount).toBe(1);
    expect(summary.worstOpen).toBe("escalate");
  });

  it("has no worst kind when nothing is open", () => {
    expect(summarizeSeatSignals([signal({ signalId: "x", state: "withdrawn" })], "main", "seat").worstOpen).toBeUndefined();
  });
});

describe("signalOutcomeLabel", () => {
  it("names each closed state and nothing for open", () => {
    expect(signalOutcomeLabel(signal({ signalId: "o" }))).toBeUndefined();
    expect(signalOutcomeLabel(signal({ signalId: "a", state: "answered" }))).toBe("answered");
    expect(signalOutcomeLabel(signal({ signalId: "w", state: "withdrawn" }))).toBe("withdrawn by agent");
  });
});

describe("sidebar section state", () => {
  it("falls back to the default until a choice is made", () => {
    expect(sectionOpen("mail", true, {})).toBe(true);
    expect(sectionOpen("mail", true, { mail: false })).toBe(false);
  });
});

describe("placeBesideRect side order", () => {
  it("honours a caller's preferred side", () => {
    const rect = { left: 900, top: 200, right: 1140, bottom: 240 };
    const point = placeBesideRect(rect, { width: 320, height: 200 }, { width: 1200, height: 800 }, ["left", "right"]);
    expect(point).toEqual({ x: 572, y: 40 });
  });
});
