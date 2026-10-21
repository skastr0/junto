import { describe, expect, it } from "vitest";
import {
  hotbarNodeSeverity,
  liveActivitySeverity,
  worseMemberSeverity,
} from "../src/renderer/lib/hotbar-signal";
import { digitHue } from "../src/renderer/lib/seat-projections";
import { MemberSeverity } from "../src/shared/region-rollup";

const S = MemberSeverity.group;


describe("hotbarNodeSeverity", () => {
  it("uses region rollup severity for groups", () => {
    expect(hotbarNodeSeverity(true, { regionSeverity: S.blocked })).toBe("blocked");
    expect(hotbarNodeSeverity(true)).toBe("idle");
  });

  it("prefers member map severity for free nodes", () => {
    expect(hotbarNodeSeverity(false, { memberSeverity: S.working })).toBe("working");
  });

  it("merges live seat severity over stale idle member map", () => {
    // Freestanding / lagging rollup said idle; canvas seat is working.
    expect(
      hotbarNodeSeverity(false, {
        memberSeverity: S.idle,
        liveSeverity: S.working,
      }),
    ).toBe("working");
  });

  it("keeps worse rollup severity when live is only working", () => {
    expect(
      hotbarNodeSeverity(false, {
        memberSeverity: S.blocked,
        liveSeverity: S.working,
      }),
    ).toBe("blocked");
  });

  it("reads a node's open tasks: one waiting for input is attention, one working is working", () => {
    expect(hotbarNodeSeverity(false, { taskStates: ["assigned", "input-required"] })).toBe("attention");
    expect(hotbarNodeSeverity(false, { taskStates: ["in-review", "working"] })).toBe("working");
    expect(hotbarNodeSeverity(false, { taskStates: ["assigned", "in-review"] })).toBe("idle");
  });

  it("reads live severity alone for freestanding agents", () => {
    expect(hotbarNodeSeverity(false, { liveSeverity: S.attention })).toBe("attention");
  });
});

describe("liveActivitySeverity", () => {
  it("maps seat working and attention", () => {
    expect(liveActivitySeverity({ seatState: "working" })).toBe("working");
    expect(liveActivitySeverity({ seatState: "attention" })).toBe("attention");
    expect(liveActivitySeverity({ seatState: "idle" })).toBe("idle");
  });


  it("reads a finished-but-unread seat as ready, not idle or attention", () => {
    expect(liveActivitySeverity({ seatState: "idle", seatNeedsLook: true })).toBe("ready");
    expect(liveActivitySeverity({ seatState: "idle", seatNeedsLook: false })).toBe("idle");
    // A dead seat has nothing to read.
    expect(liveActivitySeverity({ seatState: "gone", seatNeedsLook: true })).toBe("idle");
  });

  it("keeps ready over working and over a quiet rollup, as on the need ladder", () => {
    expect(hotbarNodeSeverity(false, { memberSeverity: S.idle, liveSeverity: S.ready })).toBe("ready");
    expect(hotbarNodeSeverity(false, { memberSeverity: S.working, liveSeverity: S.ready })).toBe("ready");
    // A seat that went quiet again drops a stale ready from the rollup.
    expect(hotbarNodeSeverity(false, { memberSeverity: S.ready, liveSeverity: S.idle })).toBe("idle");
  });
});

describe("hotbarNodeSeverity seat quiet demotion", () => {
  it("demotes lagging rollup attention when seat is idle", () => {
    expect(
      hotbarNodeSeverity(false, {
        memberSeverity: S.attention,
        liveSeverity: S.idle,
      }),
    ).toBe("idle");
  });

  it("keeps graph blocked even when seat is idle", () => {
    expect(
      hotbarNodeSeverity(false, {
        memberSeverity: S.blocked,
        liveSeverity: S.idle,
      }),
    ).toBe("blocked");
  });
});

describe("worseMemberSeverity", () => {
  it("orders blocked over working over idle", () => {
    expect(worseMemberSeverity(S.working, S.idle)).toBe("working");
    expect(worseMemberSeverity(S.blocked, S.working)).toBe("blocked");
  });
});

describe("actor chip hue is digitHue, not hotbarNodeSeverity", () => {
  it("maps graph blocked / notify attention / working / idle", () => {
    expect(digitHue({ nodeId: "a", graphBlocked: true })).toBe("blocked");
    expect(digitHue({ nodeId: "a", seatState: "attention" })).toBe("attention");
    expect(digitHue({ nodeId: "a", seatState: "working" })).toBe("working");
    expect(digitHue({ nodeId: "a", seatState: "idle" })).toBe("idle");
  });

  it("does not merge rollup severity into actor hue — facts only", () => {
    // Groups / free furniture read the rollup via hotbarNodeSeverity.
    expect(hotbarNodeSeverity(false, { memberSeverity: S.attention })).toBe("attention");
    // Actor chips ignore that merge and use digitHue on assembled facts.
    expect(digitHue({ nodeId: "n", seatState: "working" })).toBe("working");
  });
});
