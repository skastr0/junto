/**
 * The needs feed's narrowing (0.11.4): words, kinds and seats, each axis
 * independent, so one chip off leaves the rest on. The kind chips say the one
 * name every surface gives a kind, capitalised, and count what pressing them
 * would show; the seat chips name each seat with a need.
 */
import { describe, expect, it } from "vitest";
import {
  NO_FEED_FILTER,
  feedItemRank,
  feedKindChips,
  feedSeatChips,
  feedFilterOn,
  filterFeedSections,
  type FeedFilter,
  type FeedItem,
  type FeedItemKind,
  type FeedRegion,
  type FeedSection,
} from "../src/shared/operator-feed";
import { feedStatusLine, viewFeedSections } from "../src/renderer/lib/operator-feed";

const at = (itemId: string, kind: FeedItemKind, seat: string, text: string, detail?: string): FeedItem => ({
  itemId,
  kind,
  urgency: feedItemRank(kind),
  canvasName: "main",
  seat: { nodeId: seat, name: seat.replace("seat-", ""), portraitIdentity: seat },
  region: { regionId: "r", label: "R", path: ["R"] },
  text,
  ...(detail === undefined ? {} : { detail }),
  since: 0,
  ageMs: 0,
});

const items = [
  at("a", "escalate", "seat-atlas", "Ana asks about the rates", "the lease is due"),
  at("b", "blocked", "seat-bravo", "Bravo is stuck on a sign-in", undefined),
  at("c", "health", "seat-atlas", "Atlas reads steady", undefined),
  at("d", "work", "seat-cleo", "Ship the release notes", undefined),
];

const sectionOf = (regionId: string, entries: ReadonlyArray<FeedItem>): FeedSection => ({
  region: { regionId, label: regionId.toUpperCase(), path: [regionId] },
  items: entries,
  worstUrgency: entries.reduce((worst, entry) => (entry.urgency > worst ? entry.urgency : worst), entries[0]!.urgency),
});

const sections = (entries: ReadonlyArray<FeedItem>): ReadonlyArray<FeedSection> => [sectionOf("r", entries)];

const filter = (over: Partial<FeedFilter>): FeedFilter => ({ ...NO_FEED_FILTER, ...over });
const ids = (kept: ReadonlyArray<FeedSection>): ReadonlyArray<string> => kept.flatMap((section) => section.items.map((entry) => entry.itemId));

describe("the feed's filter", () => {
  it("is off when every axis is empty, and on as soon as one is set", () => {
    expect(feedFilterOn(NO_FEED_FILTER)).toBe(false);
    expect(feedFilterOn(filter({ query: "   " }))).toBe(false);
    expect(feedFilterOn(filter({ query: "rates" }))).toBe(true);
    expect(feedFilterOn(filter({ kinds: ["blocked"] }))).toBe(true);
    expect(feedFilterOn(filter({ seats: ["seat-atlas"] }))).toBe(true);
  });

  it("finds words in a need's sentence or its detail, ignoring case", () => {
    expect(ids(filterFeedSections(sections(items), filter({ query: "RATES" })))).toEqual(["a"]);
    expect(ids(filterFeedSections(sections(items), filter({ query: "LEASE IS" })))).toEqual(["a"]);
    expect(ids(filterFeedSections(sections(items), filter({ query: "notes" })))).toEqual(["d"]);
    expect(ids(filterFeedSections(sections(items), filter({ query: "nothing like it" })))).toEqual([]);
  });

  it("keeps each axis on its own: kinds and seats together narrow to both", () => {
    expect(ids(filterFeedSections(sections(items), filter({ kinds: ["escalate", "blocked"] })))).toEqual(["a", "b"]);
    expect(ids(filterFeedSections(sections(items), filter({ seats: ["seat-atlas"] })))).toEqual(["a", "c"]);
    expect(ids(filterFeedSections(sections(items), filter({ seats: ["seat-atlas"], kinds: ["escalate"] })))).toEqual(["a"]);
    // Clearing one axis leaves the other working.
    expect(ids(filterFeedSections(sections(items), filter({ seats: ["seat-atlas"], kinds: [] })))).toEqual(["a", "c"]);
  });

  it("drops a region whose needs the filter leaves out", () => {
    const kept = filterFeedSections(sections(items), filter({ kinds: ["work"] }));
    expect(kept).toHaveLength(1);
    expect(ids(kept)).toEqual(["d"]);
    expect(filterFeedSections(sections(items), filter({ kinds: ["notice"] }))).toEqual([]);
  });

  it("orders and regions what it keeps, through the one view function", () => {
    const two = [
      sectionOf("r1", [at("a", "escalate", "seat-atlas", "first"), at("b", "work", "seat-bea", "second")]),
      sectionOf("r2", [at("c", "blocked", "seat-atlas", "third")]),
    ];
    const kept = viewFeedSections(two, undefined, "main", "oldest", filter({ seats: ["seat-atlas"] }));
    // Both regions keep their one Atlas need; the work item, the only other seat's, is gone.
    expect(new Set(ids(kept))).toEqual(new Set(["a", "c"]));
    // No filter is today's feed, untouched.
    expect(new Set(ids(viewFeedSections(two, undefined, "main", "urgency")))).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("the feed's header while narrowed", () => {
  it("counts the rows a filter shows against every row the feed holds, readings included", () => {
    const feed = { count: 2, sections: sections(items) }; // four rows, two of them needs
    // A reading is a row the kind chips can narrow to, so a filter's pair counts rows.
    expect(feedStatusLine(feed, undefined, { count: 1, total: 4 })).toBe("1 of 4 shown");
    expect(feedStatusLine(feed, undefined, { count: 0, total: 4 })).toBe("0 of 4 shown");
    // A region plus a filter says both.
    expect(feedStatusLine(feed, { label: "R", count: 2 }, { count: 1, total: 4 })).toBe("1 of 4 shown in R");
    // A region alone still counts needs, as its chips do.
    expect(feedStatusLine(feed, { label: "R", count: 1 })).toBe("1 of 2 waiting in R");
  });
});

describe("the feed's chips", () => {
  it("says every kind once, in the one order, its first letter capitalised, and what it would show", () => {
    expect(feedKindChips(sections(items))).toEqual([
      { kind: "blocked", label: "Blocked", count: 1 },
      { kind: "escalate", label: "Waiting on you", count: 1 },
      { kind: "health", label: "AI read", count: 1 },
      { kind: "work", label: "To do", count: 1 },
    ]);
    // The schema's order, not the feed's: a kind first seen later still sits where its name belongs.
    expect(feedKindChips(sections([items[3]!, items[0]!])).map((chip) => chip.kind)).toEqual(["escalate", "work"]);
  });

  it("names each seat with a need, the busiest first, and how many it has", () => {
    expect(feedSeatChips(sections(items))).toEqual([
      {
        seatId: "seat-atlas",
        name: "atlas",
        count: 2,
        regionLabel: "R",
        regionPath: ["R"],
        open: false,
        color: undefined,
      },
      {
        seatId: "seat-bravo",
        name: "bravo",
        count: 1,
        regionLabel: "R",
        regionPath: ["R"],
        open: false,
        color: undefined,
      },
      {
        seatId: "seat-cleo",
        name: "cleo",
        count: 1,
        regionLabel: "R",
        regionPath: ["R"],
        open: false,
        color: undefined,
      },
    ]);
  });

  it("gives a seat its own region, so its dot takes that region's colour like the region chips", () => {
    const build: FeedRegion = { regionId: "build", label: "Build", path: ["Factory", "Build"], color: "3" };
    const field: FeedRegion = { regionId: null, label: "Open field", path: [] };
    const factory: FeedSection = {
      region: build,
      items: [{ ...at("a", "work", "seat-atlas", "one"), region: build }],
      worstUrgency: feedItemRank("work"),
    };
    const openField: FeedSection = {
      region: field,
      items: [{ ...at("b", "work", "seat-open", "two"), region: field }],
      worstUrgency: feedItemRank("work"),
    };
    expect(feedSeatChips([factory, openField])).toEqual([
      {
        seatId: "seat-atlas",
        name: "atlas",
        count: 1,
        regionLabel: "Build",
        regionPath: ["Factory", "Build"],
        open: false,
        color: "3",
      },
      {
        seatId: "seat-open",
        name: "open",
        count: 1,
        regionLabel: "Open field",
        regionPath: [],
        open: true,
        color: undefined,
      },
    ]);
  });
});
