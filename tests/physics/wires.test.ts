import { describe, expect, it } from "vitest";
import {
  connectCheck,
  connectable,
  defaultSlotForDraw,
  familiesForPair,
  familyColorToken,
  familyFromSlot,
  familyStroke,
  formatWireSentence,
  isAccessDisabled,
  isWorded,
  sentenceOf,
  wirePresentation,
  wireRolePair,
  wordsOfEdge,
} from "../../src/shared/physics/wires";
import {
  contractOf,
  sheetSectionsFor,
  sheetTitleFor,
} from "../../src/shared/physics/contracts";

describe("wires grammar", () => {
  it("allows actor–actor and actor–sink as access only", () => {
    expect(familiesForPair(wireRolePair("actor", "actor"))).toEqual(["access"]);
    expect(familiesForPair(wireRolePair("actor", "sink"))).toEqual(["access"]);
    expect(connectable("actor", "sink")).toBe(true);
  });

  it("allows actor–scheduler as trigger|effect", () => {
    expect(familiesForPair(wireRolePair("actor", "scheduler"))).toEqual([
      "trigger",
      "effect",
    ]);
  });

  it("allows sink–scheduler as watch|effect", () => {
    expect(familiesForPair(wireRolePair("sink", "scheduler"))).toEqual([
      "watch",
      "effect",
    ]);
  });

  it("allows scheduler–scheduler as trigger|effect", () => {
    expect(familiesForPair(wireRolePair("scheduler", "scheduler"))).toEqual([
      "trigger",
      "effect",
    ]);
  });

  it("refuses sink–sink and geography", () => {
    expect(connectable("sink", "sink")).toBe(false);
    expect(connectable("geography", "actor")).toBe(false);
    const refused = connectCheck("sink", "sink");
    expect(refused.ok).toBe(false);
    if (refused.ok === false) {
      expect(refused.reason).toMatch(/relay/i);
    }
  });

  it("maps slots to families", () => {
    const pair = wireRolePair("sink", "scheduler");
    expect(familyFromSlot("input", pair)).toBe("watch");
    expect(familyFromSlot("output", pair)).toBe("effect");
    expect(familyFromSlot("trigger", wireRolePair("actor", "scheduler"))).toBe(
      "trigger",
    );
    expect(familyFromSlot("recipient", wireRolePair("actor", "scheduler"))).toBe(
      "effect",
    );
  });

  it("defaults draw slots by directed roles (watch input is relay-only)", () => {
    expect(
      defaultSlotForDraw({
        fromRole: "sink",
        toRole: "scheduler",
        toKind: "relay",
      }),
    ).toBe("input");
    expect(
      defaultSlotForDraw({
        fromRole: "sink",
        toRole: "scheduler",
        toKind: "cron",
      }),
    ).toBeUndefined();
    expect(
      defaultSlotForDraw({ fromRole: "scheduler", toRole: "sink" }),
    ).toBe("output");
    expect(
      defaultSlotForDraw({
        fromRole: "actor",
        toRole: "scheduler",
        toKind: "relay",
      }),
    ).toBe("trigger");
    expect(
      defaultSlotForDraw({ fromRole: "scheduler", toRole: "actor" }),
    ).toBe("recipient");
  });

  it("formats sentences and colors", () => {
    expect(formatWireSentence(sentenceOf({ family: "access" }))).toBe("access");
    expect(
      formatWireSentence(
        sentenceOf({ family: "watch", words: ["completes"] }),
      ),
    ).toBe("watch completes");
    expect(familyColorToken("effect")).toBe("amber");
    expect(familyColorToken("access")).toBe("steel");
  });

  it("family stroke lay is solid / long-dash / dotted / solid", () => {
    expect(familyStroke("access").dasharray).toBe("none");
    expect(familyStroke("watch").dasharray).toBe("12 6");
    expect(familyStroke("trigger").dasharray).toBe("3 6");
    expect(familyStroke("effect").dasharray).toBe("none");
  });

  it("derives words and worded/disabled presentation", () => {
    // agent↔task access is bare hairline — stoppage is not an edge word.
    expect(
      wordsOfEdge({
        family: "access",
        ether: {},
        fromKind: "agent",
        toKind: "task",
      }),
    ).toEqual([]);
    expect(
      wordsOfEdge({
        family: "access",
        ether: {},
        fromKind: "board",
        toKind: "agent",
      }),
    ).toEqual(["wakes"]);
    expect(wordsOfEdge({ family: "watch", ether: {} })).toEqual(["completes"]);
    expect(
      wordsOfEdge({
        family: "effect",
        ether: { does: { mode: "set_flag" } },
      }),
    ).toEqual(["flags"]);

    expect(isWorded("access", [])).toBe(false);
    expect(isWorded("access", ["wakes"])).toBe(true);
    expect(isWorded("watch", [])).toBe(true);
    // Bare effect (no does) is not worded — no false "enqueues".
    expect(isWorded("effect", [])).toBe(false);
    expect(isWorded("effect", ["flags"])).toBe(true);
    expect(isWorded("trigger", [])).toBe(false);

    expect(
      isAccessDisabled({
        family: "access",
        offeredChipCount: 3,
        activeChipCount: 0,
      }),
    ).toBe(true);
    expect(
      isAccessDisabled({
        family: "access",
        offeredChipCount: 3,
        activeChipCount: "full",
      }),
    ).toBe(false);

    const bareAccess = wirePresentation({ family: "access", ether: {} });
    expect(bareAccess.worded).toBe(false);
    expect(bareAccess.strokeDasharray).toBe("none");

    // agent↔task is bare (no stops word). Worded access is board wake / messages.
    const taskAccess = wirePresentation({
      family: "access",
      ether: {},
      fromKind: "agent",
      toKind: "task",
    });
    expect(taskAccess.worded).toBe(false);
    expect(taskAccess.words).toEqual([]);

    const wakeAccess = wirePresentation({
      family: "access",
      ether: {},
      fromKind: "agent",
      toKind: "board",
    });
    expect(wakeAccess.worded).toBe(true);
    expect(wakeAccess.words).toContain("wakes");

    const watch = wirePresentation({ family: "watch", ether: {} });
    expect(watch.worded).toBe(true);
    expect(watch.strokeDasharray).toBe("12 6");
    expect(watch.colorToken).toBe("cyan");
  });

  it("node contracts drive sheet sections by family", () => {
    expect(contractOf("task")?.events.some((e) => e.word === "completes")).toBe(
      true,
    );
    expect(sheetTitleFor("watch")).toBe("Watch");
    const access = sheetSectionsFor({
      family: "access",
      fromKind: "agent",
      toKind: "task",
    });
    expect(access.map((s) => s._tag)).toEqual(["ports", "delete"]);
    const board = sheetSectionsFor({
      family: "access",
      fromKind: "agent",
      toKind: "board",
    });
    expect(board.map((s) => s._tag)).toEqual(["ports", "wake", "delete"]);
    const watch = sheetSectionsFor({
      family: "watch",
      fromKind: "task",
      toKind: "relay",
    });
    expect(watch[0]?._tag).toBe("when");
    const effect = sheetSectionsFor({
      family: "effect",
      fromKind: "cron",
      toKind: "task",
    });
    expect(effect[0]?._tag).toBe("does");
    const trigger = sheetSectionsFor({
      family: "trigger",
      fromKind: "agent",
      toKind: "relay",
    });
    expect(trigger.map((s) => s._tag)).toEqual(["trigger_readout", "delete"]);
  });
});
