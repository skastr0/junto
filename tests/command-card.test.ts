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
  it("classifies region, herdr, project, link, default", () => {
    expect(commandSelectionKind({ ...base, type: "group", label: "ops" })).toBe("region");
    expect(
      commandSelectionKind(
        text({ ether: { entity: { kind: "herdr" }, herdr: { host: "local" } } }),
      ),
    ).toBe("herdr");
    expect(
      commandSelectionKind(text({ ether: { herdr: { host: "remote-a" } } })),
    ).toBe("herdr");
    expect(
      commandSelectionKind(text({ ether: { entity: { kind: "project", name: "prism" } } })),
    ).toBe("project");
    expect(
      commandSelectionKind(text({ ether: { entity: { kind: "project", name: "prism" } } })),
    ).toBe("project");
    expect(commandSelectionKind({ ...base, type: "link", url: "https://x.com" })).toBe("link");
    expect(commandSelectionKind(text({ text: "note" }))).toBe("default");
    expect(commandSelectionKind(text({ ether: { entity: { kind: "agent", name: "h:p" } } }))).toBe(
      "default",
    );
  });
});

describe("primaryCommandActions", () => {
  it("herdr: open + conditional mark-seen / kill", () => {
    expect(primaryCommandActions("herdr")).toEqual(["open-terminal"]);
    expect(primaryCommandActions("herdr", { canMarkSeen: true, canKill: true })).toEqual([
      "open-terminal",
      "mark-seen",
      "kill-pane",
    ]);
    expect(primaryCommandActions("herdr", { canMarkSeen: true })).toEqual([
      "open-terminal",
      "mark-seen",
    ]);
  });

  it("project has no primary actions", () => {
    expect(primaryCommandActions("project")).toEqual([]);
  });

  it("region / link / default", () => {
    expect(primaryCommandActions("region")).toEqual([
      "arm-region",
      "pulse-region",
      "slot-cue",
    ]);
    expect(primaryCommandActions("link")).toEqual(["open-link"]);
    expect(primaryCommandActions("default")).toEqual([]);
  });
});

describe("slot helpers", () => {
  it("slotIndexOf and regionSlotCueLabel", () => {
    expect(slotIndexOf(["a", "b"], "b")).toBe(1);
    expect(slotIndexOf(["a"], "z")).toBe(null);
    expect(regionSlotCueLabel(2)).toBe("slot 3");
    expect(regionSlotCueLabel(null)).toBe("slot · Ctrl+1–9");
    expect(regionSlotCueLabel(-1)).toBe("slot · Ctrl+1–9");
  });
});
