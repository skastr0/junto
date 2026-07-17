import { describe, expect, it } from "vitest";
import {
  mergeHerdrMetaAfterRefresh,
  type HerdrMetaCache,
} from "../src/renderer/lib/herdr-state";
import type { HerdrPaneInfo } from "../src/shared/ipc";

const pane = (agentStatus: string): HerdrPaneInfo =>
  ({ paneId: "w1:p1", agentStatus }) as HerdrPaneInfo;

describe("mergeHerdrMetaAfterRefresh", () => {
  it("protects optimistic idle when seenGen advanced and remote still says done", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("idle"),
      seenGen: 2,
      fetchedAt: 100,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 1, pane("done"));
    expect(merged.agentStatus).toBe("idle");
  });

  it("accepts remote done when no local mark-seen happened", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("working"),
      seenGen: 0,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 0, pane("done"));
    expect(merged.agentStatus).toBe("done");
  });

  it("accepts remote working even after seenGen bump", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("idle"),
      seenGen: 3,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 1, pane("working"));
    expect(merged.agentStatus).toBe("working");
  });
});
