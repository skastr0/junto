import { describe, expect, it } from "vitest";
import {
  FEED_URGENCY,
  type FeedItem,
  type FeedItemKind,
  type FeedSection,
} from "../src/shared/operator-feed";
import {
  feedStatusLine,
  reconcileSelection,
  stepFeedSelection,
  viewFeedSections,
  withLeavingItems,
} from "../src/renderer/lib/operator-feed";
import { mergedQuickReplies, moveQuickReply, quickReplyForKey } from "../src/renderer/lib/quick-replies";

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

const itemAt = (
  itemId: string,
  regionId: string | null,
  since: number | undefined,
  kind: FeedItemKind = "feedback",
): FeedItem => ({
  ...item(itemId),
  kind,
  urgency: FEED_URGENCY[kind],
  region: { regionId, label: regionId ?? "open field", path: [] },
  ...(since === undefined ? { since: undefined } : { since }),
});

const region = (regionId: string | null, items: ReadonlyArray<FeedItem>): FeedSection => ({
  region: { regionId, label: regionId ?? "open field", path: [] },
  items: [...items],
  worstUrgency: Math.max(0, ...items.map((entry) => entry.urgency)),
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

  it("does not count a region that holds only AI readings", () => {
    const reads: FeedSection = { ...section("ai", ["h"]), items: [{ ...item("h"), kind: "health" }] };
    expect(feedStatusLine({ count: 0, sections: [reads] })).toBe("nobody needs you right now");
    expect(feedStatusLine({ count: 2, sections: [section("r", ["a", "b"]), reads] })).toBe("2 waiting");
  });

  it("says what the picked region holds against the whole feed", () => {
    expect(feedStatusLine({ count: 12, sections: [] }, { label: "Product", count: 3 })).toBe(
      "3 of 12 waiting in Product",
    );
    expect(feedStatusLine({ count: 12, sections: [] }, { label: "the open field", count: 0 })).toBe(
      "0 of 12 waiting in the open field",
    );
  });
});

describe("viewFeedSections", () => {
  const sections = [
    region("build", [itemAt("b-old", "build", 100), itemAt("b-new", "build", 300)]),
    region("product", [itemAt("p-mid", "product", 200, "blocked")]),
    region(null, [itemAt("f-newest", null, 400)]),
  ];

  it("keeps every region by default and narrows to the picked one", () => {
    expect(viewFeedSections(sections, undefined, "main", "urgency")).toHaveLength(3);
    const picked = viewFeedSections(
      sections,
      { canvasName: "main", regionId: "product", label: "product" },
      "main",
      "urgency",
    );
    expect(picked.map((s) => s.region.regionId)).toEqual(["product"]);
    expect(
      viewFeedSections(sections, { canvasName: "main", regionId: null, label: "open field" }, "main", "newest").map(
        (s) => s.region.regionId,
      ),
    ).toEqual([null]);
  });

  it("ignores a pick made on another canvas", () => {
    expect(
      viewFeedSections(sections, { canvasName: "other", regionId: "build", label: "build" }, "main", "urgency"),
    ).toHaveLength(3);
  });

  it("orders sections by the worst need first under urgency", () => {
    expect(viewFeedSections(sections, undefined, "main", "urgency").map((s) => s.region.regionId)).toEqual(
      ["product", "build", null],
    );
    expect(
      viewFeedSections(sections, undefined, "main", "urgency")[1]?.items.map((i) => i.itemId),
    ).toEqual(["b-old", "b-new"]);
  });

  it("orders newest and oldest first within and across sections", () => {
    const newest = viewFeedSections(sections, undefined, "main", "newest");
    expect(newest.map((s) => s.region.regionId)).toEqual([null, "build", "product"]);
    expect(newest[1]?.items.map((i) => i.itemId)).toEqual(["b-new", "b-old"]);

    const oldest = viewFeedSections(sections, undefined, "main", "oldest");
    expect(oldest.map((s) => s.region.regionId)).toEqual(["build", "product", null]);
    expect(oldest[0]?.items.map((i) => i.itemId)).toEqual(["b-old", "b-new"]);
  });

  it("always ranks a need with no known time after the dated ones", () => {
    const undated = region("undated", [itemAt("u", "undated", undefined, "blocked")]);
    const both = [...sections, undated];
    expect(viewFeedSections(both, undefined, "main", "newest").map((s) => s.region.regionId)).toContain("undated");
    expect(
      viewFeedSections(both, undefined, "main", "newest").at(-1)?.region.regionId,
    ).toBe("undated");
    expect(
      viewFeedSections(both, undefined, "main", "oldest").at(-1)?.region.regionId,
    ).toBe("undated");
  });
});

describe("mergedQuickReplies", () => {
  const replies = ["Yes", "Looks good", "Go on", "Not now"];

  it("leads with the seat's suggestions, then the operator's list", () => {
    expect(mergedQuickReplies(replies, ["Use sqlite", "Keep JSON"])).toEqual([
      "Use sqlite",
      "Keep JSON",
      "Yes",
      "Looks good",
      "Go on",
      "Not now",
    ]);
    // What the 1..9 keys send is the same list the pills number.
    expect(quickReplyForKey(mergedQuickReplies(replies, ["Use sqlite", "Keep JSON"]), "1")).toBe("Use sqlite");
    expect(quickReplyForKey(mergedQuickReplies(replies, ["Use sqlite", "Keep JSON"]), "3")).toBe("Yes");
  });

  it("drops an operator reply the seat already said, and passes a bare list through", () => {
    expect(mergedQuickReplies(replies, ["Go on"])).toEqual(["Go on", "Yes", "Looks good", "Not now"]);
    expect(mergedQuickReplies(replies, undefined)).toBe(replies);
    expect(mergedQuickReplies(replies, [])).toBe(replies);
  });
});
