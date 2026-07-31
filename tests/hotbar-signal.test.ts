import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { hotbarNodeSeverity } from "../src/renderer/lib/hotbar-signal";

const base = { id: "n", x: 0, y: 0, width: 120, height: 80 } as const;

describe("hotbarNodeSeverity", () => {
  it("uses region rollup severity for groups", () => {
    const group = { ...base, type: "group", label: "ops" } as CanvasNode;
    expect(hotbarNodeSeverity(group, { regionSeverity: "blocked" })).toBe("blocked");
    expect(hotbarNodeSeverity(group)).toBe("idle");
  });

  it("prefers member map severity for free nodes", () => {
    const node = { ...base, type: "text", text: "worker" } as CanvasNode;
    expect(hotbarNodeSeverity(node, { memberSeverity: "working" })).toBe("working");
  });

  it("reads flags when no member map", () => {
    const node = {
      ...base,
      type: "text",
      text: "x",
      ether: { flags: ["attention"] as const },
    } as CanvasNode;
    expect(hotbarNodeSeverity(node)).toBe("attention");
  });

  it("maps task sink needs-human and working", () => {
    const taskNode = (state: "input-required" | "working"): CanvasNode =>
      ({
        ...base,
        type: "text",
        text: "tasks",
        ether: {
          entity: { kind: "task" },
          tasks: {
            items: [{ id: "t1", state, history: [], claimedBy: "seat-1" }],
          },
        },
      }) as unknown as CanvasNode;
    expect(hotbarNodeSeverity(taskNode("input-required"))).toBe("attention");
    expect(hotbarNodeSeverity(taskNode("working"))).toBe("working");
  });
});
