import { describe, expect, it } from "vitest";
import type { TextNode } from "../src/shared/canvas";
import { stationIdentity, stationName } from "../src/shared/station-identity";

const station = (
  text: string,
  instruction?: string,
  id = "task-01M0STATION12345678",
): TextNode => ({
  id,
  type: "text",
  text,
  x: 0,
  y: 0,
  width: 220,
  height: 84,
  ether: {
    entity: { kind: "task" },
    tasks: {
      items: [],
      ...(instruction ? { contract: { instruction } } : {}),
    },
  },
});

describe("station identity", () => {
  it("uses the live authored node title and keeps the contract purpose as its role", () => {
    expect(stationIdentity(station("  Build  \nqueue", "Turn intent into proof."))).toEqual({
      name: "Build",
      role: "Turn intent into proof.",
      source: "title",
    });
  });

  it("treats the generic task label as unnamed and falls back to instruction", () => {
    expect(stationName(station("tasks", "Review release evidence before shipping."))).toBe(
      "Review release evidence before shipping.",
    );
  });

  it("uses a short id and teaches how to name a station when no title or role exists", () => {
    expect(stationIdentity(station("tasks", undefined))).toEqual({
      name: "Tasks 12345678",
      source: "id",
      namingHint: "Name this node to name the station.",
    });
  });

  it("resolves missing historical nodes through the same short-id fallback", () => {
    expect(stationName(undefined, "missing-station-ABCDEF12")).toBe("Tasks ABCDEF12");
  });
});
