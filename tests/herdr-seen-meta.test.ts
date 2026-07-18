import { describe, expect, it } from "vitest";
import {
  clearsPendingSeen,
  herdrMetaPaintEqual,
  mergeHerdrMetaAfterRefresh,
  type HerdrMetaCache,
} from "../src/renderer/lib/herdr-state";
import type { HerdrPaneInfo } from "../src/shared/ipc";

const pane = (agentStatus: string, extra?: Partial<HerdrPaneInfo>): HerdrPaneInfo =>
  ({ paneId: "w1:p1", agentStatus, ...extra }) as HerdrPaneInfo;

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

  it("protects idle under pendingSeen even when refresh starts after open", () => {
    // VL-030 residual: startSeenGen == nowGen (refresh began after mark-seen).
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("idle"),
      seenGen: 1,
      pendingSeen: true,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 1, pane("done"));
    expect(merged.agentStatus).toBe("idle");
  });

  it("sticky-keeps prior agentStatus when remote omits it", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("idle", { agent: "codex", cwd: "/proj" }),
      seenGen: 0,
    };
    const remote = { paneId: "w1:p1", agent: "codex" } as HerdrPaneInfo;
    const merged = mergeHerdrMetaAfterRefresh(previous, 0, remote);
    expect(merged.agentStatus).toBe("idle");
    expect(merged.cwd).toBe("/proj");
  });

  it("accepts explicit remote unknown (does not sticky over a real host value)", () => {
    const previous: HerdrMetaCache = {
      status: "ok",
      meta: pane("idle"),
      seenGen: 0,
    };
    const merged = mergeHerdrMetaAfterRefresh(previous, 0, pane("unknown"));
    expect(merged.agentStatus).toBe("unknown");
  });
});

describe("clearsPendingSeen", () => {
  it("clears on idle/working/blocked only", () => {
    expect(clearsPendingSeen("idle")).toBe(true);
    expect(clearsPendingSeen("working")).toBe(true);
    expect(clearsPendingSeen("blocked")).toBe(true);
    expect(clearsPendingSeen("done")).toBe(false);
    expect(clearsPendingSeen("unknown")).toBe(false);
    expect(clearsPendingSeen(undefined)).toBe(false);
  });
});

describe("herdrMetaPaintEqual", () => {
  it("is true for identical paint fields", () => {
    const a = pane("idle", { agent: "grok", cwd: "/x" });
    const b = pane("idle", { agent: "grok", cwd: "/x" });
    expect(herdrMetaPaintEqual(a, b)).toBe(true);
  });

  it("is false when agentStatus differs", () => {
    expect(herdrMetaPaintEqual(pane("idle"), pane("done"))).toBe(false);
  });
});
