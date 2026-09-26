import { describe, expect, it } from "vitest";
import type { FeedItem, FeedSection } from "../src/shared/operator-feed";
import {
  feedStatusLine,
  reconcileSelection,
  stepFeedSelection,
  withLeavingItems,
} from "../src/renderer/lib/operator-feed";
import { moveQuickReply, quickReplyForKey } from "../src/renderer/lib/quick-replies";

const item = (itemId: string): FeedItem => ({
  itemId,
  kind: "feedback",
  urgency: 2,
  canvasName: "main",
  seat: { nodeId: itemId, name: itemId, portraitIdentity: itemId },
  region: { regionId: "r", label: "R", path: ["R"] },
  text: "t",
  since: 0,
  ageMs: 0,
});

const section = (regionId: string | null, ids: ReadonlyArray<string>): FeedSection => ({
  region: { regionId, label: regionId ?? "open field", path: [] },
  items: ids.map(item),
  worstUrgency: 2,
});

describe("stepFeedSelection", () => {
  const items = [item("a"), item("b"), item("c")];
  it("starts at the ends and clamps", () => {
    expect(stepFeedSelection(items, null, 1)).toBe("a");
    expect(stepFeedSelection(items, null, -1)).toBe("c");
    expect(stepFeedSelection(items, "c", 1)).toBe("c");
    expect(stepFeedSelection(items, "a", -1)).toBe("a");
    expect(stepFeedSelection(items, "a", 1)).toBe("b");
  });
  it("recovers when the selected item left", () => {
    expect(stepFeedSelection(items, "gone", 1)).toBe("a");
    expect(stepFeedSelection([], "a", 1)).toBeNull();
  });
});

describe("withLeavingItems", () => {
  it("reinserts a leaving item at its old place, marked", () => {
    const previous = [section("r", ["a", "b", "c"])];
    const current = [section("r", ["a", "c"])];
    const merged = withLeavingItems(previous, current, new Set(["b"]));
    expect(merged[0]?.items.map((i) => i.itemId)).toEqual(["a", "b", "c"]);
    expect([...(merged[0]?.leavingIds ?? [])]).toEqual(["b"]);
  });

  it("keeps a section whose last item is leaving", () => {
    const merged = withLeavingItems([section("x", ["z"])], [section("r", ["a"])], new Set(["z"]));
    expect(merged.map((s) => s.region.regionId)).toEqual(["r", "x"]);
    expect(merged[1]?.leavingIds.has("z")).toBe(true);
  });

  it("ignores items that are not leaving", () => {
    const merged = withLeavingItems([section("r", ["a", "b"])], [section("r", ["a"])], new Set());
    expect(merged[0]?.items.map((i) => i.itemId)).toEqual(["a"]);
  });
});

describe("feedStatusLine", () => {
  it("speaks calmly when empty and counts regions otherwise", () => {
    expect(feedStatusLine({ count: 0, sections: [] })).toBe("nobody needs you right now");
    expect(feedStatusLine({ count: 1, sections: [section("r", ["a"])] })).toBe("1 waiting");
    expect(feedStatusLine({ count: 3, sections: [section("r", ["a"]), section(null, ["b", "c"])] })).toBe("3 waiting across 2 regions");
  });
});

describe("reconcileSelection", () => {
  const before = [{ itemId: "a" }, { itemId: "b" }, { itemId: "c" }, { itemId: "d" }];
  it("keeps a selection that is still there", () => {
    expect(reconcileSelection(before, before.slice(1), "c")).toBe("c");
  });

  it("moves to the next survivor, or back from the end, or clears", () => {
    expect(reconcileSelection(before, [{ itemId: "a" }, { itemId: "c" }, { itemId: "d" }], "b")).toBe("c");
    expect(reconcileSelection(before, [{ itemId: "a" }, { itemId: "d" }], "b")).toBe("d");
    expect(reconcileSelection(before, [{ itemId: "a" }, { itemId: "b" }], "d")).toBe("b");
    expect(reconcileSelection(before, [], "b")).toBeNull();
    expect(reconcileSelection(before, before, null)).toBeNull();
    expect(reconcileSelection(before, before.slice(1), "gone")).toBeNull();
  });
});

describe("quick reply keys and order", () => {
  const replies = ["Yes", "No", "Continue"];
  it("maps 1..9 onto the list and ignores other keys", () => {
    expect(quickReplyForKey(replies, "1")).toBe("Yes");
    expect(quickReplyForKey(replies, "3")).toBe("Continue");
    expect(quickReplyForKey(replies, "4")).toBeNull();
    expect(quickReplyForKey(replies, "0")).toBeNull();
    expect(quickReplyForKey(replies, "j")).toBeNull();
  });

  it("moves one reply up or down within the list", () => {
    expect(moveQuickReply(replies, 0, 1)).toEqual(["No", "Yes", "Continue"]);
    expect(moveQuickReply(replies, 2, -1)).toEqual(["Yes", "Continue", "No"]);
    expect(moveQuickReply(replies, 0, -1)).toBe(replies);
    expect(moveQuickReply(replies, 2, 1)).toBe(replies);
  });
});
