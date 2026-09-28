import { describe, expect, it } from "vitest";
import { regionUrgencies, seatUrgencyOfRing, worseUrgency } from "../src/renderer/lib/region-urgency";

describe("seatUrgencyOfRing", () => {
  it("reads what the ring draws: halt and a declared blocker are blocked", () => {
    expect(seatUrgencyOfRing({ glyph: "halt" })).toBe("blocked");
    expect(seatUrgencyOfRing({ glyph: "work", signal: "blocked" })).toBe("blocked");
  });

  it("needs you for a dialog, a request, or a fresh waiting reading", () => {
    expect(seatUrgencyOfRing({ glyph: "call" })).toBe("needs-you");
    expect(seatUrgencyOfRing({ glyph: "work", signal: "escalate" })).toBe("needs-you");
    expect(seatUrgencyOfRing({ glyph: "rest", health: "waiting" })).toBe("needs-you");
    expect(seatUrgencyOfRing({ glyph: "rest", health: "waiting", healthStale: true })).toBeUndefined();
  });

  it("is review for a declared review request, and quiet otherwise", () => {
    expect(seatUrgencyOfRing({ glyph: "done", signal: "feedback" })).toBe("review");
    expect(seatUrgencyOfRing({ glyph: "work" })).toBeUndefined();
    expect(seatUrgencyOfRing({ glyph: "done", health: "trouble" })).toBeUndefined();
  });

  it("ranks blocked over needs you over review", () => {
    expect(worseUrgency("review", "needs-you")).toBe("needs-you");
    expect(worseUrgency("blocked", "needs-you")).toBe("blocked");
    expect(worseUrgency(undefined, "review")).toBe("review");
  });
});

describe("regionUrgencies", () => {
  // outer > mid > inner; side sits beside mid in outer.
  const parent: Record<string, string> = { mid: "outer", inner: "mid", side: "outer" };
  const home: Record<string, string> = { a: "inner", b: "side", c: "" };
  const run = (seats: { id: string; urgency: "blocked" | "needs-you" | "review" }[]) =>
    regionUrgencies(seats, (id) => home[id], (id) => parent[id]);

  it("marks the seat's region direct and every region around it held", () => {
    const out = run([{ id: "a", urgency: "blocked" }]);
    expect(out.get("inner")).toEqual({ urgency: "blocked", reach: "direct" });
    expect(out.get("mid")).toEqual({ urgency: "blocked", reach: "held" });
    expect(out.get("outer")).toEqual({ urgency: "blocked", reach: "held" });
    expect(out.has("side")).toBe(false);
  });

  it("lets a region's own seats speak for it, and holds the worst below only when it has none", () => {
    const out = regionUrgencies(
      [
        { id: "a", urgency: "blocked" },
        { id: "b", urgency: "review" },
        { id: "d", urgency: "review" },
      ],
      (id) => ({ a: "inner", b: "side", d: "mid" })[id],
      (id) => parent[id],
    );
    expect(out.get("side")).toEqual({ urgency: "review", reach: "direct" });
    expect(out.get("mid")).toEqual({ urgency: "review", reach: "direct" });
    expect(out.get("outer")).toEqual({ urgency: "blocked", reach: "held" });
  });

  it("ignores seats in no region", () => {
    expect(run([{ id: "c", urgency: "needs-you" }]).size).toBe(0);
  });
});
