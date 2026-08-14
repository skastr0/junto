import { describe, expect, it } from "vitest";
import {
  applyHotbarLeases,
  emptyHotbarSlots,
} from "../src/renderer/lib/hotbar-slots";
import {
  cardMark,
  digitLease,
  notifyItem,
  type SeatFacts,
} from "../src/renderer/lib/seat-projections";

const facts = (over: Partial<SeatFacts> & { readonly nodeId?: string }): SeatFacts => ({
  nodeId: over.nodeId ?? "n1",
  ...over,
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
});

describe("digitLease", () => {
  it("leases only working or attention", () => {
    expect(digitLease(facts({ seatState: "working" }))).toBe(true);
    expect(digitLease(facts({ seatState: "attention" }))).toBe(true);
    expect(digitLease(facts({ seatState: "idle" }))).toBe(false);
    expect(digitLease(facts({ seatState: "unknown" }))).toBe(false);
    expect(digitLease(facts({ seatState: "gone" }))).toBe(false);
    expect(digitLease(facts({ graphBlocked: true }))).toBe(false);
    expect(digitLease(facts({ flags: ["attention"] }))).toBe(false);
  });
});

describe("notifyItem", () => {
  it("notifies only graph-blocked or attention", () => {
    expect(notifyItem(facts({ graphBlocked: true }))).toBe("blocked");
    expect(notifyItem(facts({ seatState: "attention" }))).toBe("attention");
    expect(notifyItem(facts({ flags: ["attention"] }))).toBe("attention");
    expect(notifyItem(facts({ seatState: "working" }))).toBeNull();
    expect(notifyItem(facts({ seatState: "idle" }))).toBeNull();
    expect(notifyItem(facts({ seatState: "unknown" }))).toBeNull();
    expect(notifyItem(facts({ graphBlocked: true, seatState: "working" }))).toBe(
      "blocked",
    );
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
