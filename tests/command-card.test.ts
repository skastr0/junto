import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import {
  commandSelectionKind,
  primaryCommandActions,
  regionSlotCueLabel,
  slotIndexOf,
} from "../src/renderer/lib/command-card";

const base = { id: "n", x: 0, y: 0, width: 200, height: 80 } as const;

const text = (over: Partial<CanvasNode> & { type?: "text"; text?: string } = {}): CanvasNode =>
  ({
    ...base,
    type: "text",
    text: "x",
    ...over,
  }) as CanvasNode;

describe("commandSelectionKind", () => {
  it("classifies region, link, default", () => {
    expect(commandSelectionKind({ ...base, type: "group", label: "ops" })).toBe("region");
    expect(
      commandSelectionKind(text({ ether: { entity: { kind: "project", name: "prism" } } })),
    ).toBe("default");
    expect(commandSelectionKind({ ...base, type: "link", url: "https://x.com" })).toBe("default");
    expect(
      commandSelectionKind({
        ...base,
        type: "link",
        url: "https://x.com",
        ether: {
          entity: { kind: "page" },
          host: "local",
          browser: { profile: "personal" },
        },
      }),
    ).toBe("link");
    expect(commandSelectionKind(text({ text: "note" }))).toBe("default");
    expect(commandSelectionKind(text({ ether: { entity: { kind: "agent", name: "h:p" } } }))).toBe(
      "default",
    );
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
