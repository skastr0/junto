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

  it("reaches every offered port of every kind through some verb", () => {
    for (const kind of WELL_KNOWN_KINDS) {
      for (const port of KindSpecs[kind].offers) {
        const reachable = PAIRS.some(
          (pair) =>
            (pair[0] === kind || pair[1] === kind) &&
            grantsOf(pair).some((grant) => grant.ports.includes(port)),
        );
        expect(reachable, `${kind} offers ${port} but no verb grants it`).toBe(
          true,
        );
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

  it("gives target-only kinds no verb back toward an agent", () => {
    for (const kind of ["requests", "artifacts", "board", "page"] as const) {
      expect(verbsForPair(kind, "agent"), kind).toEqual([]);
    }
  });

  it("refuses a verb the pair does not hold", () => {
    expect(compileVerb("works", "agent", "task")).toBeUndefined();
    expect(compileVerb("edits", "agent", "board")).toBeUndefined();
    expect(compileVerb("messages", "agent", "pad")).toBeUndefined();
  });

  it("wires geography and unknown kinds to nothing", () => {
    expect(verbsForPair("group", "agent")).toEqual([]);
    expect(verbsForPair("agent", undefined)).toEqual([]);
    expect(defaultVerbForPair("agent", "herdr")).toBeUndefined();
  });

  it("snapshots the whole pair matrix", () => {
    const matrix: Record<string, ReadonlyArray<Verb>> = {};
    for (const pair of PAIRS) {
      const verbs = verbsForPair(pair[0], pair[1]);
      if (verbs.length > 0) matrix[`${pair[0]}>${pair[1]}`] = verbs;
    }
    expect(matrix).toEqual({
      "agent>agent": ["messages"],
      "agent>task": ["manages", "contributes"],
      "agent>requests": ["escalates"],
      "agent>artifacts": ["publishes"],
      "agent>board": ["messages", "participates"],
      "agent>pad": ["reads", "edits"],
      "agent>page": ["navigates"],
      "agent>relay": ["fires", "announces"],
      "task>agent": ["works"],
      "task>task": ["feeds"],
      "task>relay": ["announces"],
      "requests>relay": ["announces"],
      "artifacts>relay": ["announces"],
      "board>relay": ["announces"],
      "pad>relay": ["announces"],
      "page>relay": ["announces"],
      "relay>agent": ["wakes", "flags"],
      "relay>task": ["enqueues", "flags"],
      "relay>requests": ["flags"],
      "relay>artifacts": ["flags"],
      "relay>board": ["flags"],
      "relay>pad": ["flags"],
      "relay>page": ["flags"],
      "relay>terminal": ["flags"],
      "relay>relay": ["chains"],
      "relay>cron": ["chains"],
      "relay>timer": ["chains"],
      "relay>watcher": ["chains"],
      "cron>agent": ["wakes", "flags"],
      "cron>task": ["enqueues", "flags"],
      "cron>requests": ["flags"],
      "cron>artifacts": ["flags"],
      "cron>board": ["flags"],
      "cron>pad": ["flags"],
      "cron>page": ["flags"],
      "cron>terminal": ["flags"],
      "cron>relay": ["chains"],
      "cron>cron": ["chains"],
      "cron>timer": ["chains"],
      "cron>watcher": ["chains"],
      "timer>agent": ["wakes", "flags"],
      "timer>task": ["enqueues", "flags"],
      "timer>requests": ["flags"],
      "timer>artifacts": ["flags"],
      "timer>board": ["flags"],
      "timer>pad": ["flags"],
      "timer>page": ["flags"],
      "timer>terminal": ["flags"],
      "timer>relay": ["chains"],
      "timer>cron": ["chains"],
      "timer>timer": ["chains"],
      "timer>watcher": ["chains"],
      "watcher>agent": ["wakes", "flags"],
      "watcher>task": ["enqueues", "flags"],
      "watcher>requests": ["flags"],
      "watcher>artifacts": ["flags"],
      "watcher>board": ["flags"],
      "watcher>pad": ["flags"],
      "watcher>page": ["flags"],
      "watcher>terminal": ["flags"],
      "watcher>relay": ["chains"],
      "watcher>cron": ["chains"],
      "watcher>timer": ["chains"],
      "watcher>watcher": ["chains"],
    });
  });
});

describe("compiled grants", () => {
  it("gives a task hop no ports at all", () => {
    expect(compileVerb("feeds", "task", "task")).toEqual({
      ports: [],
      flow: true,
    });
  });

  it("marks only works as assignable", () => {
    expect(compileVerb("works", "task", "agent")).toEqual({
      ports: [
        "tasks.list",
        "tasks.claim",
        "tasks.update",
        "msg.list",
        "msg.send",
      ],
      assignable: true,
    });
    for (const pair of PAIRS) {
      for (const verb of verbsForPair(pair[0], pair[1])) {
        if (verb === "works") continue;
        expect(
          compileVerb(verb, pair[0], pair[1])?.assignable,
          `${verb} on ${pair[0]}>${pair[1]}`,
        ).toBeUndefined();
      }
    }
  });

  it("separates managing a task from contributing to it", () => {
    expect(compileVerb("manages", "agent", "task")?.ports).not.toContain(
      "tasks.claim",
    );
    expect(compileVerb("contributes", "agent", "task")?.ports).toContain(
      "tasks.claim",
    );
  });

  it("splits the board on wake and topic creation", () => {
    expect(compileVerb("messages", "agent", "board")).toEqual({
      ports: ["board.list", "board.post", "board.mark_read"],
      wake: false,
    });
    expect(compileVerb("participates", "agent", "board")).toEqual({
      ports: [
        "board.list",
        "board.create_topic",
        "board.post",
        "board.mark_read",
      ],
      wake: true,
    });
  });

  it("announces each kind's own headline event", () => {
    const whenOf = (kind: WellKnownKind) =>
      compileVerb("announces", kind, "relay")?.when;
    expect(whenOf("task")).toEqual({ word: "completes" });
    expect(whenOf("requests")).toEqual({ word: "completes" });
    expect(whenOf("artifacts")).toEqual({ word: "completes" });
    expect(whenOf("board")).toEqual({ word: "completes", equals: "post" });
    expect(whenOf("page")).toEqual({ word: "completes", equals: "ready" });
    expect(whenOf("pad")).toEqual({ word: "flagged", flag: "attention" });
    expect(whenOf("agent")).toEqual({ word: "flagged", flag: "attention" });
  });

  it("compiles scheduler pushes to their fire actions", () => {
    expect(compileVerb("enqueues", "cron", "task")?.does).toEqual({
      mode: "enqueue_task",
      data: {},
    });
    expect(compileVerb("wakes", "relay", "agent")?.does).toEqual({
      mode: "inject_prompt",
    });
    expect(compileVerb("flags", "relay", "page")?.does).toEqual({
      mode: "set_flag",
      flag: "attention",
      enabled: true,
    });
    expect(compileVerb("chains", "cron", "relay")).toEqual({
      ports: [],
      chain: true,
      when: { word: "completes" },
    });
  });

  it("defaults a plain connect to the fuller relationship", () => {
    expect(defaultVerbForPair("agent", "task")).toBe("contributes");
    expect(defaultVerbForPair("agent", "board")).toBe("participates");
    expect(defaultVerbForPair("agent", "pad")).toBe("edits");
    expect(defaultVerbForPair("agent", "relay")).toBe("fires");
    expect(defaultVerbForPair("relay", "task")).toBe("enqueues");
    expect(defaultVerbForPair("cron", "agent")).toBe("wakes");
    expect(defaultVerbForPair("task", "task")).toBe("feeds");
    for (const pair of PAIRS) {
      const verbs = verbsForPair(pair[0], pair[1]);
      if (verbs.length === 0) continue;
      expect(verbs).toContain(defaultVerbForPair(pair[0], pair[1]));
    }
  });
});

describe("legacy conversion", () => {
  it("reads task hops and actor mail off the pair alone", () => {
    expect(inferVerb({}, "task", "task")).toBe("feeds");
    expect(inferVerb(undefined, "agent", "agent")).toBe("messages");
  });

  it("converts access wires in either drawn direction", () => {
    expect(inferVerb({ ports: ["tasks.list"] }, "agent", "task")).toBe(
      "contributes",
    );
    expect(inferVerb({ ports: ["tasks.list"] }, "task", "agent")).toBe(
      "contributes",
    );
    expect(inferVerb({}, "pad", "agent")).toBe("edits");
    expect(inferVerb({}, "agent", "page")).toBe("navigates");
    expect(inferVerb({}, "agent", "requests")).toBe("escalates");
    expect(inferVerb({}, "artifacts", "agent")).toBe("publishes");
  });

  it("keeps an opted-out board seat out of the megaphone", () => {
    expect(inferVerb({ wake: false }, "agent", "board")).toBe("messages");
    expect(inferVerb({ wake: true }, "agent", "board")).toBe("participates");
    expect(inferVerb({}, "board", "agent")).toBe("participates");
  });

  it("tells an agent trigger from an agent watch", () => {
    expect(inferVerb({ slot: "trigger" }, "agent", "relay")).toBe("fires");
    expect(inferVerb({ ports: ["relay.trigger"] }, "relay", "agent")).toBe(
      "fires",
    );
    expect(
      inferVerb({ when: { word: "flagged", flag: "attention" } }, "agent", "relay"),
    ).toBe("announces");
    expect(inferVerb({}, "agent", "relay")).toBe("announces");
  });

  it("converts watch and effect wires by their authored word", () => {
    expect(inferVerb({ when: { word: "completes" } }, "task", "relay")).toBe(
      "announces",
    );
    expect(inferVerb({}, "board", "relay")).toBe("announces");
    expect(
      inferVerb({ does: { mode: "enqueue_task", data: {} } }, "cron", "task"),
    ).toBe("enqueues");
    expect(inferVerb({ does: { mode: "inject_prompt" } }, "relay", "agent")).toBe(
      "wakes",
    );
    expect(
      inferVerb(
        { does: { mode: "set_flag", flag: "blocker", enabled: true } },
        "relay",
        "requests",
      ),
    ).toBe("flags");
    expect(
      inferVerb({ does: { mode: "board_post", data: {} } }, "cron", "board"),
    ).toBe("flags");
    expect(inferVerb({}, "timer", "task")).toBe("enqueues");
    expect(inferVerb({}, "relay", "relay")).toBe("chains");
  });

  it("drops what the grammar no longer holds", () => {
    expect(inferVerb({}, "agent", "terminal")).toBeUndefined();
    expect(inferVerb({}, "agent", "group")).toBeUndefined();
    expect(inferVerb({}, "agent", undefined)).toBeUndefined();
    expect(inferVerb({ when: { word: "completes" } }, "task", "cron")).toBeUndefined();
    expect(inferVerb({}, "task", "board")).toBeUndefined();
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
