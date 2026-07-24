import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  ActivityFeed,
  ActivityFeedNull,
  HostLiveness,
  HostLivenessNull,
  nullActivityFeed,
  nullHostLiveness,
} from "../src/shared/occupancy";

// S5 cut 1 — seam contract. Real producers (renderer ACP plane, PTY/fleet
// lanes) bind against these same Tags without touching consumers; this file
// only proves the interface + null producer that ships in this cut.

describe("ActivityFeed — null producer", () => {
  it("has no opinion about any node (vacant everywhere)", () => {
    expect(nullActivityFeed.clueFor("n1")).toBeUndefined();
    expect(nullActivityFeed.clueFor("")).toBeUndefined();
  });

  it("resolves through the Effect Context.Tag / Layer contract", async () => {
    const program = Effect.gen(function* () {
      const feed = yield* ActivityFeed;
      return feed.clueFor("any-node");
    });
    const result = await Effect.runPromise(Effect.provide(program, ActivityFeedNull));
    expect(result).toBeUndefined();
  });
});

describe("HostLiveness — null producer", () => {
  it("reports every host reachable (host always up)", () => {
    expect(nullHostLiveness.isReachable("station-a")).toBe(true);
    expect(nullHostLiveness.isReachable("anything")).toBe(true);
  });

  it("resolves through the Effect Context.Tag / Layer contract", async () => {
    const program = Effect.gen(function* () {
      const liveness = yield* HostLiveness;
      return liveness.isReachable("station-a");
    });
    const result = await Effect.runPromise(Effect.provide(program, HostLivenessNull));
    expect(result).toBe(true);
  });
});
