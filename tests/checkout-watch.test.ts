import { describe, expect, it } from "vitest";
import {
  CheckoutWatcher,
  type GitProbe,
} from "../src/main/vellum-command/work/checkout-watch";
import type { ActorSeatId } from "../src/shared/actor-seat";

// Provenance: an observation carries the process identity that was bound
// when the commit was attributed — verbatim, never re-read — so re-emitted
// receipts can never be relabelled with a replacement generation.

const SEAT = "seat-a" as ActorSeatId;

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

describe("checkout observation provenance", () => {
  it("an observation carries the binding's generation and harness verbatim", async () => {
    let head = "h1";
    const watcher = new CheckoutWatcher(
      probe({
        head: async () => ({ branch: "main", head }),
        newCommits: async () => ["c1"],
      }),
      () => {},
    );
    watcher.track(
      { checkoutKey: "co-1", worktree: "/wt" },
      {
        checkoutKey: "co-1",
        seatId: SEAT,
        taskId: "t1",
        via: "claim-context",
        generation: "gen-7",
        harness: "claude",
      },
    );
    await watcher.scan(); // baseline
    head = "h2";
    const observations = await watcher.scan();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      seatId: SEAT,
      generation: "gen-7",
      harness: "claude",
    });
  });

  it("a binding without process identity attributes with them absent", async () => {
    let head = "h1";
    const watcher = new CheckoutWatcher(
      probe({
        head: async () => ({ branch: "main", head }),
        newCommits: async () => ["c1"],
      }),
      () => {},
    );
    watcher.track(
      { checkoutKey: "co-1", worktree: "/wt" },
      { checkoutKey: "co-1", seatId: SEAT, taskId: "t1", via: "claim-context" },
    );
    await watcher.scan(); // baseline
    head = "h2";
    const observations = await watcher.scan();
    expect(observations).toHaveLength(1);
    expect(observations[0]?.seatId).toBe(SEAT);
    expect(observations[0]?.generation).toBeUndefined();
    expect(observations[0]?.harness).toBeUndefined();
  });
});
