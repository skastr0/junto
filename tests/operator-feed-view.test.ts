import { describe, expect, it } from "vitest";
import {
  feedItemRank,
  type FeedItem,
  type FeedItemKind,
  type FeedSection,
} from "../src/shared/operator-feed";
import {
  feedRegionChips,
  feedStatusLine,
  holdFeedPlaces,
  reconcileSelection,
  stepFeedSelection,
  viewFeedSections,
} from "../src/renderer/lib/operator-feed";
import { mergedQuickReplies, moveQuickReply, quickReplyForKey } from "../src/renderer/lib/quick-replies";

const item = (itemId: string): FeedItem => ({
  itemId,
  kind: "feedback",
  urgency: feedItemRank("feedback"),
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
  urgency: feedItemRank(kind),
  region: { regionId, label: regionId ?? "open field", path: regionId === null ? [] : [regionId] },
  ...(since === undefined ? { since: undefined } : { since }),
});

const region = (regionId: string | null, items: ReadonlyArray<FeedItem>): FeedSection => ({
  region: { regionId, label: regionId ?? "open field", path: regionId === null ? [] : [regionId] },
  items: [...items],
  worstUrgency: [...items].sort((a, b) => b.urgency - a.urgency)[0]?.urgency ?? feedItemRank("feedback"),
});

const section = (regionId: string | null, ids: ReadonlyArray<string>): FeedSection => ({
  region: { regionId, label: regionId ?? "open field", path: regionId === null ? [] : [regionId] },
  items: ids.map(item),
  worstUrgency: feedItemRank("feedback"),
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

describe("holdFeedPlaces", () => {
  const shownOf = (...sections: ReadonlyArray<FeedSection>) => holdFeedPlaces([], sections, new Set());
  const layout = (sections: ReturnType<typeof holdFeedPlaces>) =>
    sections.map((s) => `${s.region.regionId}: ${s.items.map((i) => (s.leavingIds.has(i.itemId) ? `(${i.itemId})` : i.itemId)).join(" ")}`);

  it("keeps a leaving item at its old place, marked", () => {
    const held = holdFeedPlaces(shownOf(section("r", ["a", "b", "c"])), [section("r", ["a", "c"])], new Set(["b"]));
    expect(layout(held)).toEqual(["r: a (b) c"]);
  });

  it("keeps a region whose last item is leaving where it was, not at the end", () => {
    const shown = shownOf(section("x", ["z"]), section("r", ["a"]), section("s", ["b"]));
    const held = holdFeedPlaces(shown, [section("r", ["a"]), section("s", ["b"])], new Set(["z"]));
    expect(layout(held)).toEqual(["x: (z)", "r: a", "s: b"]);
  });

  it("drops a gone item once it is no longer leaving, and its empty region", () => {
    const held = holdFeedPlaces(shownOf(section("x", ["z"]), section("r", ["a", "b"])), [section("r", ["a"])], new Set());
    expect(layout(held)).toEqual(["r: a"]);
  });

  it("holds what is shown through a re-rank", () => {
    const shown = shownOf(section("r", ["a", "b"]), section("x", ["c"]));
    const held = holdFeedPlaces(shown, [section("x", ["c"]), section("r", ["b", "a"])], new Set());
    expect(layout(held)).toEqual(["r: a b", "x: c"]);
  });

  it("puts a new item and a new region where the ranking puts them", () => {
    const shown = shownOf(section("r", ["a", "c"]), section("x", ["d"]));
    const held = holdFeedPlaces(
      shown,
      [section("n", ["m"]), section("r", ["p", "q", "a", "b", "c"]), section("x", ["d", "e"])],
      new Set(),
    );
    expect(layout(held)).toEqual(["n: m", "r: p q a b c", "x: d e"]);
  });

  it("draws an item that moved region in its new one, not fading in the old", () => {
    const shown = shownOf(section("r", ["a", "b"]), section("x", ["c"]));
    const held = holdFeedPlaces(shown, [section("r", ["a"]), section("x", ["b", "c"])], new Set(["b"]));
    expect(layout(held)).toEqual(["r: a", "x: b c"]);
  });

  it("draws the ranking's own copy of an item that stays", () => {
    const fresh = { ...item("a"), text: "asked again" };
    const ranked: FeedSection = { ...section("r", ["a"]), items: [fresh] };
    expect(holdFeedPlaces(shownOf(section("r", ["a"])), [ranked], new Set())[0]?.items[0]).toBe(fresh);
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

/** A region section at a path, outer to inner, with its own colour when given. */
const nested = (path: ReadonlyArray<string>, kinds: ReadonlyArray<FeedItemKind>, color?: string): FeedSection => ({
  region: { regionId: path.join("/") || null, label: path.at(-1) ?? "open field", path: [...path], ...(color ? { color } : {}) },
  items: kinds.map((kind, index) => ({ ...item(`${path.join("/")}#${index}`), kind, urgency: feedItemRank(kind) })),
  worstUrgency: kinds.map(feedItemRank).sort((a, b) => b - a)[0]!,
});

describe("region chips and the parent pick", () => {
  const security = nested(["sobcontrole", "Cloud", "Security"], ["escalate", "blocked"], "3");
  const cloud = nested(["sobcontrole", "Cloud"], ["feedback"], "5");
  const vouch = nested(["Vouch"], ["escalate"]);
  const open = nested([], ["escalate"]);

  it("lists every region and each one around it, a parent just before its first child, in section order", () => {
    const chips = feedRegionChips([security, vouch, cloud, open]);
    expect(chips.map((chip) => [...chip.outer, chip.label].join(" > "))).toEqual([
      "sobcontrole",
      "sobcontrole > Cloud",
      "sobcontrole > Cloud > Security",
      "Vouch",
      "open field",
    ]);
    expect(chips.map((chip) => chip.open)).toEqual([false, false, false, false, true]);
  });

  it("rolls a parent's count up from its children, and keeps a colour only a region's own section gave", () => {
    const chips = feedRegionChips([security, vouch, cloud, open]);
    const count = (label: string) => chips.find((chip) => chip.label === label)?.count;
    expect(count("Security")).toBe(2);
    expect(count("Cloud")).toBe(3);
    expect(count("sobcontrole")).toBe(3);
    expect(count("Vouch")).toBe(1);
    expect(count("open field")).toBe(1);
    expect(chips.find((chip) => chip.label === "sobcontrole")?.color).toBeUndefined();
    expect(chips.find((chip) => chip.label === "Cloud")?.color).toBe("5");
    expect(chips.find((chip) => chip.label === "Security")?.color).toBe("3");
  });

  it("does not count an AI reading, though it lists it", () => {
    const quiet = nested(["Vouch"], ["health"]);
    expect(feedRegionChips([quiet]).find((chip) => chip.label === "Vouch")?.count).toBe(0);
  });

  it("keeps a pick with nothing left in it, at the end, so the strip says what is chosen", () => {
    const chips = feedRegionChips([vouch], ["sobcontrole", "Cloud"]);
    expect(chips.at(-1)).toMatchObject({ label: "Cloud", outer: ["sobcontrole"], count: 0, color: undefined });
  });

  it("narrows to a parent and every region inside it, and the open field to itself", () => {
    const sections = [security, vouch, cloud, open];
    const shown = (path: ReadonlyArray<string>) =>
      viewFeedSections(sections, { canvasName: "main", path }, "main", "urgency").map((s) => s.region.path.join(" > "));
    expect(shown(["sobcontrole"]).sort()).toEqual(["sobcontrole > Cloud", "sobcontrole > Cloud > Security"]);
    expect(shown(["sobcontrole", "Cloud", "Security"])).toEqual(["sobcontrole > Cloud > Security"]);
    expect(shown([])).toEqual([""]);
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
      { canvasName: "main", path: ["product"] },
      "main",
      "urgency",
    );
    expect(picked.map((s) => s.region.regionId)).toEqual(["product"]);
    expect(
      viewFeedSections(sections, { canvasName: "main", path: [] }, "main", "newest").map(
        (s) => s.region.regionId,
      ),
    ).toEqual([null]);
  });

  it("ignores a pick made on another canvas", () => {
    expect(
      viewFeedSections(sections, { canvasName: "other", path: ["build"] }, "main", "urgency"),
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
