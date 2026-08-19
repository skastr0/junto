import { describe, expect, it } from "vitest";
import {
  applyHotbarLeases,
  emptyHotbarSlots,
} from "../src/renderer/lib/hotbar-slots";
import {
  cardMark,
  digitHue,
  digitLease,
  attentionAgentKey,
  attentionReasonsForNode,
  liveAttentionReasons,
  notifyItem,
  seatFactsForNode,
  type SeatFacts,
} from "../src/renderer/lib/seat-projections";

const facts = (over: Partial<SeatFacts> & { readonly nodeId?: string }): SeatFacts => ({
  nodeId: over.nodeId ?? "n1",
  ...over,
});

describe("seatFactsForNode", () => {
  it("joins node id, seat, session, flags, and herdr into one object", () => {
    expect(
      seatFactsForNode({
        nodeId: "a",
        seatEvent: { state: "working", reason: "turn" },
        session: { status: "running", processName: "grok" },
        graphBlocked: false,
        flags: ["attention"],
        attentionReasons: ["permission:pending"],
        managedSeat: true,
        herdrAgentStatus: "idle",
      }),
    ).toMatchObject({
      nodeId: "a",
      seatState: "working",
      seatReason: "turn",
      running: true,
      starting: false,
      processName: "grok",
      flags: ["attention"],
      attentionReasons: ["permission:pending"],
      managedSeat: true,
      graphBlocked: false,
    });
  });

  it("maps herdr blocked onto graphBlocked when no seat event", () => {
    expect(
      seatFactsForNode({
        nodeId: "h",
        herdrAgentStatus: "blocked",
      }),
    ).toMatchObject({ graphBlocked: true, seatState: undefined });
  });
});

describe("cardMark", () => {
  it("idle seated is quiet steel", () => {
    expect(
      cardMark(facts({ seatState: "idle", running: true, managedSeat: true })),
    ).toMatchObject({ mode: "static", tone: "steel", label: "idle" });
  });

  it("unknown/missing managed seat is seated/unknown, not a grok process wave", () => {
    expect(
      cardMark(
        facts({
          running: true,
          processName: "grok",
          managedSeat: true,
        }),
      ),
    ).toMatchObject({ mode: "static", tone: "steel", label: "seated" });
    expect(
      cardMark(
        facts({
          seatState: "unknown",
          running: true,
          processName: "claude",
          managedSeat: true,
        }),
      ),
    ).toMatchObject({ mode: "static", tone: "steel", label: "seated" });
    expect(cardMark(facts({ seatState: "unknown", managedSeat: true }))).toMatchObject({
      mode: "static",
      tone: "steel",
      label: "unknown",
    });
  });

  it("unmanaged npm still paints a green process wave", () => {
    expect(
      cardMark(facts({ running: true, processName: "npm", managedSeat: false })),
    ).toMatchObject({
      mode: "wave",
      tone: "green",
      label: "process — npm",
    });
  });

  it("flag attention and live reasons elevate the card to attention", () => {
    expect(cardMark(facts({ seatState: "idle", flags: ["attention"] }))).toMatchObject({
      tone: "amber",
    });
    expect(
      cardMark(facts({ seatState: "working", attentionReasons: ["permission:pending"] })),
    ).toMatchObject({ tone: "amber" });
  });
});

describe("digitLease", () => {
  it("leases working, seat attention, and elevated attention", () => {
    expect(digitLease(facts({ seatState: "working" }))).toBe(true);
    expect(digitLease(facts({ seatState: "attention" }))).toBe(true);
    expect(digitLease(facts({ flags: ["attention"] }))).toBe(true);
    expect(digitLease(facts({ attentionReasons: ["work:input-required"] }))).toBe(
      true,
    );
    expect(digitLease(facts({ seatState: "idle" }))).toBe(false);
    expect(digitLease(facts({ seatState: "unknown" }))).toBe(false);
    expect(digitLease(facts({ seatState: "gone" }))).toBe(false);
    expect(digitLease(facts({ graphBlocked: true }))).toBe(false);
  });
});

describe("notifyItem", () => {
  it("notifies only graph-blocked or attention", () => {
    expect(notifyItem(facts({ graphBlocked: true }))).toBe("blocked");
    expect(notifyItem(facts({ seatState: "attention" }))).toBe("attention");
    expect(notifyItem(facts({ flags: ["attention"] }))).toBe("attention");
    expect(notifyItem(facts({ attentionReasons: ["permission:pending"] }))).toBe(
      "attention",
    );
    expect(notifyItem(facts({ seatState: "working" }))).toBeNull();
    expect(notifyItem(facts({ seatState: "idle" }))).toBeNull();
    expect(notifyItem(facts({ seatState: "unknown" }))).toBeNull();
    expect(notifyItem(facts({ graphBlocked: true, seatState: "working" }))).toBe(
      "blocked",
    );
  });
});

describe("one facts object drives card, digit, notify, and hue", () => {
  it("flag attention: card amber, lease, notify attention, hue attention", () => {
    const f = facts({ seatState: "idle", flags: ["attention"] });
    expect(cardMark(f).tone).toBe("amber");
    expect(digitLease(f)).toBe(true);
    expect(notifyItem(f)).toBe("attention");
    expect(digitHue(f)).toBe("attention");
  });

  it("live reasons elevate the same four projections", () => {
    const f = facts({
      seatState: "idle",
      attentionReasons: ["permission:pending"],
    });
    expect(cardMark(f).tone).toBe("amber");
    expect(digitLease(f)).toBe(true);
    expect(notifyItem(f)).toBe("attention");
    expect(digitHue(f)).toBe("attention");
  });

  it("graphBlocked: card blocked, hue blocked, notify blocked, no lease", () => {
    const f = facts({ graphBlocked: true, seatState: "idle" });
    expect(cardMark(f)).toMatchObject({ tone: "crimson", label: "blocked" });
    expect(digitLease(f)).toBe(false);
    expect(notifyItem(f)).toBe("blocked");
    expect(digitHue(f)).toBe("blocked");
  });

  it("working: card cyan, lease, no notify, hue working", () => {
    const f = facts({ seatState: "working" });
    expect(cardMark(f).tone).toBe("cyan");
    expect(digitLease(f)).toBe(true);
    expect(notifyItem(f)).toBeNull();
    expect(digitHue(f)).toBe("working");
  });

  it("flags+graphBlocked: card and hue blocked, lease still true", () => {
    const f = facts({ graphBlocked: true, flags: ["attention"] });
    expect(cardMark(f).tone).toBe("crimson");
    expect(digitLease(f)).toBe(true);
    expect(notifyItem(f)).toBe("blocked");
    expect(digitHue(f)).toBe("blocked");
  });
});

describe("attentionReasonsForNode — one node, its own coarse slice", () => {
  it("permission on the node's own slice, with no map in sight", () => {
    expect(
      attentionReasonsForNode(
        { ether: { entity: { kind: "agent", name: "local:pi" } } },
        { pendingPermissionId: "p1" },
      ),
    ).toEqual(["permission:pending"]);
  });

  it("no slice -> no permission reason; sink reasons still come from ether", () => {
    expect(
      attentionReasonsForNode({
        ether: { entity: { kind: "agent", name: "local:pi" } },
      }),
    ).toEqual([]);
    expect(
      attentionReasonsForNode({
        ether: {
          entity: { kind: "requests" },
          requests: { items: [{ state: "auth-required" }] },
        },
      }),
    ).toEqual(["work:auth-required"]);
  });

  it("attentionAgentKey names the one key a seat depends on", () => {
    expect(
      attentionAgentKey({ ether: { entity: { kind: "agent", name: "local:pi" } } }),
    ).toBe("local:pi");
    expect(attentionAgentKey({ ether: { entity: { kind: "task" } } })).toBeUndefined();
    expect(attentionAgentKey({})).toBeUndefined();
  });
});

describe("liveAttentionReasons", () => {
  it("collects permission and sink input-required", () => {
    expect(
      liveAttentionReasons(
        { ether: { entity: { kind: "agent", name: "local:pi" } } },
        { "local:pi": { pendingPermissionId: "p1" } },
      ),
    ).toEqual(["permission:pending"]);
    expect(
      liveAttentionReasons({
        ether: {
          entity: { kind: "task" },
          tasks: { items: [{ state: "input-required" }] },
        },
      }),
    ).toEqual(["work:input-required"]);
  });
});

describe("hotbar eviction from digitLease", () => {
  it("working→idle evicts the chip instead of deleting it", () => {
    let slots = emptyHotbarSlots();
    const working = facts({ nodeId: "a", seatState: "working" });
    slots = applyHotbarLeases(
      slots,
      ["a"],
      ["a"],
      digitLease(working) ? ["a"] : [],
    );
    expect(slots[0]).toEqual({ kind: "leased", nodeId: "a" });

    const idle = facts({ nodeId: "a", seatState: "idle" });
    const next = applyHotbarLeases(
      slots,
      ["a"],
      ["a"],
      digitLease(idle) ? ["a"] : [],
    );
    expect(next[0]).toEqual({ kind: "evicted", nodeId: "a" });
  });
});
