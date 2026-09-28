import { HashSet } from "effect";
import { describe, expect, it } from "vitest";
import { KindSpecs } from "../../src/shared/physics/kinds";
import {
  WELL_KNOWN_KINDS,
  type Port,
  type WellKnownKind,
} from "../../src/shared/physics/schema";
import {
  compileVerb,
  defaultVerbForPair,
  inferVerb,
  VERB_COLOR_TOKEN,
  VERBS,
  verbsForPair,
  type Verb,
} from "../../src/shared/physics/verbs";

type Pair = readonly [WellKnownKind, WellKnownKind];

const PAIRS: ReadonlyArray<Pair> = WELL_KNOWN_KINDS.flatMap((source) =>
  WELL_KNOWN_KINDS.map((target) => [source, target] as Pair),
);

/** The kinds an agent canvas still draws. */
const LIVE_KINDS: ReadonlyArray<WellKnownKind> = ["agent", "page", "terminal"];

const grantsOf = (
  pair: Pair,
): ReadonlyArray<{ readonly verb: Verb; readonly ports: ReadonlyArray<Port> }> =>
  verbsForPair(pair[0], pair[1]).map((verb) => {
    const grant = compileVerb(verb, pair[0], pair[1]);
    if (grant === undefined) {
      throw new Error(`${verb} on ${pair[0]}>${pair[1]} compiles to nothing`);
    }
    return { verb, ports: grant.ports };
  });

describe("verb table", () => {
  it("only grants ports the pair actually offers", () => {
    for (const pair of PAIRS) {
      const offered = HashSet.union(
        KindSpecs[pair[0]].offers,
        KindSpecs[pair[1]].offers,
      );
      for (const { verb, ports } of grantsOf(pair)) {
        for (const port of ports) {
          expect(
            HashSet.has(offered, port),
            `${verb} on ${pair[0]}>${pair[1]} grants unoffered ${port}`,
          ).toBe(true);
        }
      }
    }
  });

  it("never admits more than two verbs on one ordered pair", () => {
    for (const pair of PAIRS) {
      const verbs = verbsForPair(pair[0], pair[1]);
      expect(verbs.length, `${pair[0]}>${pair[1]}`).toBeLessThanOrEqual(2);
      expect(new Set(verbs).size).toBe(verbs.length);
    }
  });

  it("gives a page no verb back toward an agent", () => {
    expect(verbsForPair("page", "agent")).toEqual([]);
  });

  it("refuses a verb the pair does not hold", () => {
    expect(compileVerb("navigates", "agent", "agent")).toBeUndefined();
    expect(compileVerb("messages", "agent", "page")).toBeUndefined();
    expect(compileVerb("messages", "agent", "terminal")).toBeUndefined();
  });

  it("wires geography and unknown kinds to nothing", () => {
    expect(verbsForPair("group", "agent")).toEqual([]);
    expect(verbsForPair("agent", undefined)).toEqual([]);
  });

  it("snapshots the pair matrix among live kinds", () => {
    const matrix: Record<string, ReadonlyArray<Verb>> = {};
    for (const source of LIVE_KINDS) {
      for (const target of LIVE_KINDS) {
        const verbs = verbsForPair(source, target);
        if (verbs.length > 0) matrix[`${source}>${target}`] = verbs;
      }
    }
    expect(matrix).toEqual({
      "agent>agent": ["messages", "reviews"],
      "agent>page": ["navigates"],
    });
  });
});

describe("compiled grants", () => {
  it("opens the mailbox, prompt, wait and terminal read between two agents", () => {
    expect(compileVerb("messages", "agent", "agent")).toEqual({
      ports: ["msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read"],
    });
  });

  it("lets an agent drive a page and nothing more", () => {
    expect(compileVerb("navigates", "agent", "page")).toEqual({
      ports: ["browser.automate"],
    });
  });

  it("never grants a port the far end of the wire does not offer", () => {
    // Tighter than the union rule: an actor's own inbox must not leak into a
    // wire, so the grant is checked against the offers of the end that is not
    // the seat.
    for (const pair of PAIRS) {
      const far =
        pair[0] === "agent" && pair[1] === "agent"
          ? "agent"
          : pair[0] === "agent"
            ? pair[1]
            : pair[1] === "agent"
              ? pair[0]
              : undefined;
      if (far === undefined) continue;
      for (const { verb, ports } of grantsOf(pair)) {
        for (const port of ports) {
          expect(
            HashSet.has(KindSpecs[far].offers, port),
            `${verb} on ${pair[0]}>${pair[1]} grants ${port}, which ${far} does not offer`,
          ).toBe(true);
        }
      }
    }
  });

  it("defaults a plain connect to the fuller relationship", () => {
    expect(defaultVerbForPair("agent", "agent")).toBe("messages");
    expect(defaultVerbForPair("agent", "page")).toBe("navigates");
    for (const pair of PAIRS) {
      const verbs = verbsForPair(pair[0], pair[1]);
      if (verbs.length === 0) continue;
      expect(verbs).toContain(defaultVerbForPair(pair[0], pair[1]));
    }
  });
});

describe("legacy conversion", () => {
  it("reads actor mail off the pair alone", () => {
    expect(inferVerb(undefined, "agent", "agent")).toBe("messages");
    expect(inferVerb({}, "agent", "page")).toBe("navigates");
  });

  it("drops what the grammar no longer holds", () => {
    expect(inferVerb({}, "agent", "terminal")).toBeUndefined();
    expect(inferVerb({}, "agent", "group")).toBeUndefined();
    expect(inferVerb({}, "agent", undefined)).toBeUndefined();
  });
});

describe("verb paint", () => {
  it("names one css custom property per verb", () => {
    for (const verb of VERBS) {
      expect(VERB_COLOR_TOKEN[verb]).toBe(`--wire-verb-${verb}`);
    }
    expect(Object.keys(VERB_COLOR_TOKEN).sort()).toEqual([...VERBS].sort());
  });
});
