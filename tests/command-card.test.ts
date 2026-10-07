import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/model";
import { note, seat, region, page } from "./support/model-nodes";
import {
  commandSelectionKind,
  primaryCommandActions,
  regionSlotCueLabel,
  slotIndexOf,
} from "../src/renderer/lib/command-card";

describe("commandSelectionKind", () => {
  it("classifies region, page, and other native kinds", () => {
    expect(commandSelectionKind(region("ops", { x: 0, y: 0, width: 200, height: 80 }))).toBe("region");
    expect(commandSelectionKind(page("page"))).toBe("link");
    expect(commandSelectionKind({ kind: "link", id: asNodeId("link"), x: 0, y: 0, width: 200, height: 80, z: 0, url: "https://x.com" })).toBe("default");
    expect(commandSelectionKind(note("note"))).toBe("default");
    expect(commandSelectionKind(seat("agent"))).toBe("default");
  });
});

describe("primaryCommandActions", () => {


  it("region / link / default include slot-cue", () => {
    expect(primaryCommandActions("region")).toEqual(["hold-region", "slot-cue"]);
    expect(primaryCommandActions("link")).toEqual(["open-link", "slot-cue"]);
    expect(primaryCommandActions("default")).toEqual(["slot-cue"]);
  });
});

describe("slot helpers", () => {
  it("slotIndexOf and regionSlotCueLabel", () => {
    expect(slotIndexOf(["a", "b"], "b")).toBe(1);
    expect(slotIndexOf(["a"], "z")).toBe(null);
    expect(regionSlotCueLabel(2)).toBe("Hotkey slot 3");
    expect(regionSlotCueLabel(null)).toBe("Assign hotkey slot");
    expect(regionSlotCueLabel(-1)).toBe("Assign hotkey slot");
  });
});
