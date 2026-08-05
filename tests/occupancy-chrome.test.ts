import { describe, expect, it } from "vitest";
import { OccupancySpectrum, deriveOccupancy } from "../src/shared/occupancy";
import type { CanvasDoc } from "../src/shared/canvas";
import { occupancyChrome } from "../src/renderer/lib/occupancy-chrome";
import { chatActivityFeed } from "../src/renderer/lib/occupancy-feed";
import type { AgentChatCoarse } from "../src/renderer/lib/chat-state";

type Node = CanvasDoc["nodes"][number];

const STATES = OccupancySpectrum.literals;

describe("occupancyChrome — visual alphabet is total over the spectrum", () => {
  it("has a chrome spec for all eight states", () => {
    expect(STATES).toHaveLength(8);
    for (const state of STATES) {
      const spec = occupancyChrome(state);
      expect(spec.state).toBe(state);
      expect(spec.attr).toBe(state);
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });

  it("every state gets its own data-occupancy attribute (no shared badge)", () => {
    const attrs = STATES.map((state) => occupancyChrome(state).attr);
    expect(new Set(attrs).size).toBe(attrs.length);
  });
});

describe("occupancyChrome — I12: three blocked-ish vocabularies never collapse", () => {
  it("attention (needs-input), activity_blocked (line-stopped), stalled (clock) carry distinct words", () => {
    const attention = occupancyChrome("attention");
    const blocked = occupancyChrome("activity_blocked");
    const stalled = occupancyChrome("stalled");

    expect(attention.vocabulary).toBe("needs-input");
    expect(blocked.vocabulary).toBe("line-stopped");
    expect(stalled.vocabulary).toBe("stalled");

    const labels = [attention.label, blocked.label, stalled.label];
    expect(new Set(labels).size).toBe(3);

    // Never use one state's word for another — e.g. "blocked" must not
    // appear in the attention or stalled label, and vice versa.
    expect(attention.label).not.toContain("stopped");
    expect(attention.label).not.toContain("stalled");
    expect(blocked.label).not.toContain("input");
    expect(blocked.label).not.toContain("stalled");
    expect(stalled.label).not.toContain("input");
    expect(stalled.label).not.toContain("stopped");
  });

  it("only the three I12 states carry a vocabulary tag", () => {
    const tagged = STATES.filter((s) => occupancyChrome(s).vocabulary !== undefined);
    expect(tagged.sort()).toEqual(["activity_blocked", "attention", "stalled"].sort());
  });
});

describe("occupancyChrome — I20: gone/unreachable chrome is honest", () => {
  it("reads 'Machine unreachable', never stopped/revoked/compromised", () => {
    const gone = occupancyChrome("gone");
    expect(gone.label).toBe("Machine unreachable");
    for (const forbidden of ["stopped", "revoked", "compromised", "banned", "terminated"]) {
      expect(gone.label.toLowerCase()).not.toContain(forbidden);
    }
    expect(gone.label.toLowerCase()).toContain("unreachable");
  });
});

describe("occupancyChrome — table: spectrum state -> chrome (all eight)", () => {
  const now = 1_700_000_000_000;
  const table: ReadonlyArray<{
    readonly name: string;
    readonly input: Parameters<typeof deriveOccupancy>[0];
    readonly expected: (typeof STATES)[number];
  }> = [
    { name: "vacant, never seen", input: { hasOccupant: false, nowMs: now }, expected: "empty" },
    {
      name: "vacant, formerly bound",
      input: { hasOccupant: false, lastSeenAtMs: now - 1, nowMs: now },
      expected: "gone",
    },
    { name: "bound, quiet", input: { hasOccupant: true, nowMs: now }, expected: "idle" },
    {
      name: "bound, working",
      input: { hasOccupant: true, activity: { harness: "working" }, nowMs: now },
      expected: "working",
    },
    {
      name: "bound, needs input",
      input: { hasOccupant: true, flags: { attention: true }, nowMs: now },
      expected: "attention",
    },
    {
      name: "bound, line stopped",
      input: { hasOccupant: true, activity: { harness: "blocked" }, nowMs: now },
      expected: "activity_blocked",
    },
    {
      name: "bound, stale heartbeat",
      input: { hasOccupant: true, lastSeenAtMs: now - 25 * 60 * 60 * 1000, nowMs: now },
      expected: "stalled",
    },
    {
      name: "bound, parked",
      input: { hasOccupant: true, flags: { parked: true }, nowMs: now },
      expected: "parked",
    },
  ];

  it.each(table)("$name -> $expected chrome", ({ input, expected }) => {
    const state = deriveOccupancy(input);
    expect(state).toBe(expected);
    const chrome = occupancyChrome(state);
    expect(chrome.attr).toBe(expected);
  });
});

describe("I11 — occupancy is derived, never document truth", () => {
  const node = (id: string, agentKey?: string): Node => ({
    id,
    type: "text",
    text: id,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    ...(agentKey ? { ether: { entity: { kind: "agent", name: agentKey } } } : {}),
  });

  it("running occupancy derivation across a churn of live states never mutates the document", () => {
    const doc: CanvasDoc = {
      nodes: [node("seat-1", "local:agentA"), node("seat-2", "local:agentB"), node("seat-3")],
      edges: [],
    };
    const before = JSON.stringify(doc);

    const churns: ReadonlyArray<Record<string, AgentChatCoarse>> = [
      { "local:agentA": { status: "idle", turnBusy: false, hasBusyTools: false } },
      { "local:agentA": { status: "live", turnBusy: false, hasBusyTools: false } },
      {
        "local:agentA": { status: "live", turnBusy: true, hasBusyTools: true },
        "local:agentB": { status: "connecting", turnBusy: false, hasBusyTools: false },
      },
      {
        "local:agentA": {
          status: "live",
          pendingPermissionId: "req-1",
          turnBusy: false,
          hasBusyTools: false,
        },
      },
      { "local:agentB": { status: "error", turnBusy: false, hasBusyTools: false } },
    ];

    const now = 1_700_000_000_000;
    for (const chat of churns) {
      const feed = chatActivityFeed(doc, chat);
      for (const n of doc.nodes) {
        const clue = feed.clueFor(n.id);
        const state = deriveOccupancy({
          hasOccupant: clue?.hasOccupant ?? false,
          activity: clue?.activity,
          lastSeenAtMs: clue?.lastSeenAtMs,
          flags: clue?.flags,
          nowMs: now,
        });
        // Exercise the chrome mapping too — still must not touch the doc.
        void occupancyChrome(state);
      }
    }

    expect(JSON.stringify(doc)).toBe(before);
    // No occupancy field of any kind was written onto a node.
    for (const n of doc.nodes) {
      expect(n).not.toHaveProperty("occupancy");
      expect((n as unknown as { ether?: { occupancy?: unknown } }).ether?.occupancy).toBeUndefined();
    }
  });
});
