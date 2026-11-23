/**
 * The needs-you feed in the order to act (part 8): with no signal naming
 * another it is exactly Most urgent first; ten raised in order read one to
 * ten, take three rows, and the next is on top after each answer; the other
 * orders never put a chain upside down; a waiting card says what it waits on.
 */
import { describe, expect, it } from "vitest";
import { feedItemRank, orderFeedSections, type FeedItem, type FeedItemKind, type FeedSection } from "../src/shared/operator-feed";
import {
  dependsTail,
  feedChainPlaces,
  feedDependsLineOf,
  foldFeedChains,
  foldedItemIds,
  groupFeedChains,
  notHereWords,
  waitsOnTarget,
} from "../src/window/lib/feed-order";

const card = (id: string, kind: FeedItemKind, since: number, order: Partial<FeedItem> = {}, seat = "seat-a"): FeedItem => ({
  itemId: `signal:${id}`,
  signalId: id,
  kind,
  urgency: feedItemRank(kind),
  canvasName: "main",
  seat: { nodeId: seat, name: seat, portraitIdentity: seat },
  region: { regionId: "r", label: "R", path: ["R"] },
  text: `the words of ${id}`,
  since,
  ageMs: 0,
  ...order,
});

const section = (items: ReadonlyArray<FeedItem>): FeedSection => ({
  region: { regionId: "r", label: "R", path: ["R"] },
  items,
  worstUrgency: Math.max(...items.map((item) => item.urgency)) as FeedItem["urgency"],
});

const idsOf = (sections: ReadonlyArray<FeedSection>): string[] => sections.flatMap((one) => one.items.map((item) => item.signalId!));

/** A batch raised first to last, each after the one before, as the core reads them while all are open. */
const batch = (size: number, kind: FeedItemKind = "escalate"): FeedItem[] =>
  Array.from({ length: size }, (_, n) =>
    card(`s${String(n + 1)}`, kind, 1_000 + n, n === 0 ? {} : { dependsOn: [`s${String(n)}`], ready: false, waitingOn: [`s${String(n)}`] }),
  );

/** The feed after the first open card is answered: it leaves, and the one after it is ready. */
const answerFirst = (items: ReadonlyArray<FeedItem>): FeedItem[] => {
  const [first, ...rest] = items;
  return rest.map((item) =>
    item.waitingOn?.includes(first!.signalId!) === true ? { ...item, ready: true, waitingOn: undefined } : item,
  ) as FeedItem[];
};

describe("the feed in the order to act", () => {
  it("is exactly Most urgent first while no signal names another", () => {
    const kinds: FeedItemKind[] = ["notice", "blocked", "escalate", "feedback", "blocked", "work", "attention", "escalate"];
    const items = kinds.map((kind, n) => card(`k${String(n)}`, kind, [500, 100, 300, 200, 50, 400, 250, 300][n]!));
    const two = [section(items.slice(0, 4)), { ...section(items.slice(4)), region: { regionId: "q", label: "Q", path: ["Q"] } }];
    expect(orderFeedSections(two, "act")).toEqual(orderFeedSections(two, "urgency"));
  });

  it("reads ten raised in order one to ten, whatever order they come in", () => {
    const ten = batch(10);
    expect(idsOf(orderFeedSections([section([...ten].reverse())], "act"))).toEqual(ten.map((item) => item.signalId));
  });

  it("puts the most urgent thing that can be acted on first, lifted by what waits on it", () => {
    const quiet = card("quiet", "feedback", 10);
    const urgent = card("urgent", "blocked", 20, { dependsOn: ["quiet"], ready: false, waitingOn: ["quiet"] });
    const middle = card("middle", "escalate", 5, {}, "seat-b");
    expect(idsOf(orderFeedSections([section([middle, urgent, quiet])], "act"))).toEqual(["quiet", "middle", "urgent"]);
  });

  it("keeps a chain in its order in Newest first and Oldest first", () => {
    const ten = batch(10);
    for (const order of ["newest", "oldest", "urgency"] as const) {
      const shown = idsOf(orderFeedSections([section(ten)], order));
      expect(shown).toEqual(ten.map((item) => item.signalId));
    }
    // Between signals in no order, the chosen order still decides.
    const free = [card("p", "escalate", 1), card("q", "escalate", 2)];
    expect(idsOf(orderFeedSections([section(free)], "newest"))).toEqual(["q", "p"]);
  });

  it("draws ten in order as three rows, and the next on top after each answer", () => {
    let open = batch(10);
    for (let answered = 0; answered < 10; answered += 1) {
      const drawn = groupFeedChains(orderFeedSections([section(open)], "act")[0]!.items);
      const places = feedChainPlaces(drawn);
      const rows = foldFeedChains(drawn, places, new Set());
      const next = rows[0];
      expect(next?.kind === "card" ? next.item.signalId : undefined).toBe(`s${String(answered + 1)}`);
      const left = 10 - answered;
      expect(rows.length).toBe(Math.min(left, 3));
      if (left > 2) expect(rows[2]).toMatchObject({ kind: "fold", count: left - 2 });
      if (left > 1) expect(places.get(drawn[0]!.itemId)).toMatchObject({ index: 1, size: left });
      open = answerFirst(open);
    }
  });

  it("draws a chain together where its first card stands, and unfolds it whole", () => {
    const [s1, s2, s3] = batch(3);
    const other = card("other", "escalate", 1_001, {}, "seat-b");
    // Ranked, a ready card of another seat sits between the chain's ready head and its waiting cards.
    const ranked = orderFeedSections([section([s1!, s2!, s3!, other])], "act")[0]!.items;
    expect(ranked.map((item) => item.signalId)).toEqual(["s1", "other", "s2", "s3"]);
    const drawn = groupFeedChains(ranked);
    expect(drawn.map((item) => item.signalId)).toEqual(["s1", "s2", "s3", "other"]);
    const places = feedChainPlaces(drawn);
    const folded = foldFeedChains(drawn, places, new Set());
    expect(folded.map((row) => (row.kind === "card" ? row.item.signalId : `fold ${String(row.count)}`))).toEqual(["s1", "s2", "fold 1", "other"]);
    expect([...foldedItemIds(drawn, folded)]).toEqual(["signal:s3"]);
    const whole = foldFeedChains(drawn, places, new Set(["signal:s3"]));
    expect(whole.every((row) => row.kind === "card")).toBe(true);
  });

  it("says what a waiting card waits on, and goes to the first of them still open", () => {
    const [s1, s2] = batch(2);
    const both = card("both", "escalate", 2_000, { dependsOn: ["s1", "s2", "far"], ready: false, waitingOn: ["s2", "s1"], notReceived: ["far"] });
    const inOrder = [s1!, s2!, both];
    expect(waitsOnTarget(both, inOrder)?.signalId).toBe("s1");
    const line = feedDependsLineOf(both, inOrder);
    expect(line).toMatchObject({ kind: "waiting", more: 1, notHere: 1 });
    expect(line?.kind === "waiting" ? dependsTail(line) : "").toBe("and 1 more, 1 not here yet");
    expect(waitsOnTarget(s1!, inOrder)).toBeUndefined();
    expect(feedDependsLineOf(s1!, inOrder)).toBeUndefined();
    // Waiting only on one not here: drawn ready, and says so.
    const far = card("far-only", "escalate", 3_000, { dependsOn: ["far"], ready: true, notReceived: ["far"] });
    expect(feedDependsLineOf(far, inOrder)).toEqual({ kind: "not-here", count: 1 });
    expect(notHereWords(1)).toBe("Depends on a signal not here yet. Ready now.");
    expect(dependsTail({ kind: "waiting", first: undefined, more: 0, notHere: 1 })).toBe("and 1 not here yet");
  });

  it("orders a batch of fifty", () => {
    const fifty = batch(50);
    const drawn = groupFeedChains(orderFeedSections([section([...fifty].reverse())], "act")[0]!.items);
    expect(drawn.map((item) => item.signalId)).toEqual(fifty.map((item) => item.signalId));
    expect(foldFeedChains(drawn, feedChainPlaces(drawn), new Set())).toHaveLength(3);
  });
});
