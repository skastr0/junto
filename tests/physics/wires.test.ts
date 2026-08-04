import { describe, expect, it } from "vitest";
import {
  connectCheck,
  connectable,
  defaultSlotForDraw,
  familiesForPair,
  familyColorToken,
  familyFromSlot,
  formatWireSentence,
  sentenceOf,
  wireRolePair,
} from "../../src/shared/physics/wires";

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

  it("defaults draw slots by directed roles", () => {
    expect(
      defaultSlotForDraw({ fromRole: "sink", toRole: "scheduler" }),
    ).toBe("input");
    expect(
      defaultSlotForDraw({ fromRole: "scheduler", toRole: "sink" }),
    ).toBe("output");
    expect(
      defaultSlotForDraw({ fromRole: "actor", toRole: "scheduler" }),
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
    ).toBe("watch · completes");
    expect(familyColorToken("effect")).toBe("amber");
    expect(familyColorToken("access")).toBe("steel");
  });
});
