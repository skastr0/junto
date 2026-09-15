import { describe, expect, it } from "vitest";
import {
  CheckoutAttribution,
  CheckoutWatcher,
  type GitProbe,
} from "../src/main/vellum-command/work/checkout-watch";
import type { ActorSeatId } from "../src/shared/actor-seat";

// Independent adversarial seam tests for the checkout commit watch
// (docs/crew-contract.md receipt feed): attribution ambiguity, baseline
// silence, sha normalization, and lastSeen advancement semantics.

const SEAT_A = "seat-a" as ActorSeatId;
const SEAT_B = "seat-b" as ActorSeatId;

const probe = (impl: {
  head?: (w: string) => Promise<{ branch: string; head: string } | undefined>;
  newCommits?: (
    w: string,
    from: string,
    to: string,
  ) => Promise<ReadonlyArray<string>>;
}): GitProbe => ({
  head: impl.head ?? (async () => ({ branch: "main", head: "h1" })),
  newCommits: impl.newCommits ?? (async () => []),
});

describe("checkout attribution — proven context only", () => {
  it("zero bindings attributes nothing", () => {
    const a = new CheckoutAttribution();
    expect(a.attribute("co-1")).toBeUndefined();
  });

  it("two distinct seats on one checkout is ambiguous — attributes nothing", () => {
    const a = new CheckoutAttribution();
    a.bind({ checkoutKey: "co-1", seatId: SEAT_A, taskId: "t1", via: "claim-context" });
    a.bind({ checkoutKey: "co-1", seatId: SEAT_B, taskId: "t2", via: "claim-context" });
    expect(a.attribute("co-1")).toBeUndefined();
    expect([...a.seatsFor("co-1")].sort()).toEqual([SEAT_A, SEAT_B].sort());
  });

  it("one seat's re-bind moves forward; the seat stays single", () => {
    const a = new CheckoutAttribution();
    a.bind({ checkoutKey: "co-1", seatId: SEAT_A, taskId: "t1", via: "claim-context" });
    a.bind({ checkoutKey: "co-1", seatId: SEAT_A, taskId: "t2", via: "update-context" });
    const b = a.attribute("co-1");
    expect(b?.taskId).toBe("t2");
    expect(b?.via).toBe("update-context");
  });

  it("releasing one of two seats resolves ambiguity to the survivor", () => {
    const a = new CheckoutAttribution();
    a.bind({ checkoutKey: "co-1", seatId: SEAT_A, taskId: "t1", via: "claim-context" });
    a.bind({ checkoutKey: "co-1", seatId: SEAT_B, taskId: "t2", via: "claim-context" });
    a.release("co-1", SEAT_B);
    expect(a.attribute("co-1")?.seatId).toBe(SEAT_A);
  });

  it("releaseTask clears a task's bindings across every checkout", () => {
    const a = new CheckoutAttribution();
    a.bind({ checkoutKey: "co-1", seatId: SEAT_A, taskId: "t1", via: "claim-context" });
    a.bind({ checkoutKey: "co-2", seatId: SEAT_B, taskId: "t1", via: "update-context" });
    a.releaseTask("t1");
    expect(a.attribute("co-1")).toBeUndefined();
    expect(a.attribute("co-2")).toBeUndefined();
  });
});

describe("checkout watcher scan — honest bounded pass", () => {
  it("the first scan records a baseline and emits nothing", async () => {
    const emitted: string[] = [];
    const w = new CheckoutWatcher(
      probe({ newCommits: async () => ["c1"] }),
      (obs) => obs.forEach((o) => emitted.push(o.sha)),
    );
    w.track({ checkoutKey: "co-1", worktree: "/wt" });
    const first = await w.scan();
    expect(first).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("observations carry the single bound seat and normalize shas", async () => {
    let head = "h1";
    const w = new CheckoutWatcher(
      probe({
        head: async () => ({ branch: "main", head }),
        newCommits: async () => ["  ABCDEF  "],
      }),
      () => {},
    );
    w.track(
      { checkoutKey: "co-1", worktree: "/wt" },
      { checkoutKey: "co-1", seatId: SEAT_A, taskId: "t1", via: "claim-context" },
    );
    await w.scan(); // baseline
    head = "h2";
    const obs = await w.scan();
    expect(obs).toHaveLength(1);
    expect(obs[0]).toEqual({
      checkoutKey: "co-1",
      sha: "abcdef",
      seatId: SEAT_A,
      taskId: "t1",
      attributedVia: "claim-context",
    });
  });

  it("commits scanned while a checkout is ambiguous are unattributed", async () => {
    let head = "h1";
    const w = new CheckoutWatcher(
      probe({
        head: async () => ({ branch: "main", head }),
        newCommits: async () => ["c1"],
      }),
      () => {},
    );
    w.track({ checkoutKey: "co-1", worktree: "/wt" });
    w.bindings().bind({ checkoutKey: "co-1", seatId: SEAT_A, taskId: "t1", via: "claim-context" });
    w.bindings().bind({ checkoutKey: "co-1", seatId: SEAT_B, taskId: "t2", via: "claim-context" });
    await w.scan(); // baseline
    head = "h2";
    const obs = await w.scan();
    expect(obs).toHaveLength(1);
    expect(obs[0]?.seatId).toBeUndefined();
  });

  it(
    "a newCommits failure retries the exact range — lastSeen commits only " +
      "after successful enumeration and emission",
    async () => {
      let head = "h1";
      let calls = 0;
      const emitted: string[] = [];
      const w = new CheckoutWatcher(
        probe({
          head: async () => ({ branch: "main", head }),
          newCommits: async () => {
            calls += 1;
            if (calls === 1) throw new Error("rev-list boom");
            return ["c1", "c2"];
          },
        }),
        (obs) => obs.forEach((o) => emitted.push(o.sha)),
      );
      w.track(
        { checkoutKey: "co-1", worktree: "/wt" },
        { checkoutKey: "co-1", seatId: SEAT_A, taskId: "t1", via: "claim-context" },
      );
      await w.scan(); // baseline at h1
      head = "h2";
      await expect(w.scan()).rejects.toThrow("rev-list boom");
      // The failed range h1..h2 must not be skipped: the next scan must
      // still enumerate it.
      const obs = await w.scan();
      expect(obs.map((o) => o.sha)).toEqual(["c1", "c2"]);
      expect(emitted).toEqual(["c1", "c2"]);
    },
  );

  it(
    "an onObservations throw leaves every watermark in place — emission " +
      "is the commit point, so the exact range re-emits next scan",
    async () => {
      let head = "h1";
      let sinkCalls = 0;
      const emitted: string[] = [];
      const w = new CheckoutWatcher(
        probe({
          head: async () => ({ branch: "main", head }),
          newCommits: async () => ["c1", "c2"],
        }),
        (obs) => {
          sinkCalls += 1;
          if (sinkCalls === 1) throw new Error("durable sink boom");
          obs.forEach((o) => emitted.push(o.sha));
        },
      );
      w.track(
        { checkoutKey: "co-1", worktree: "/wt" },
        { checkoutKey: "co-1", seatId: SEAT_A, taskId: "t1", via: "claim-context" },
      );
      await w.scan(); // baseline at h1
      head = "h2";
      await expect(w.scan()).rejects.toThrow("durable sink boom");
      const obs = await w.scan();
      expect(obs.map((o) => o.sha)).toEqual(["c1", "c2"]);
      expect(emitted).toEqual(["c1", "c2"]);
    },
  );
});
