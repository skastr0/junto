import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import {
  hotbarNodeSeverity,
  liveActivitySeverity,
  worseMemberSeverity,
} from "../src/renderer/lib/hotbar-signal";

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

  it("merges live seat severity over stale idle member map", () => {
    // Freestanding / lagging rollup said idle; canvas seat is working.
    const node = { ...base, type: "text", text: "Pi" } as CanvasNode;
    expect(
      hotbarNodeSeverity(node, {
        memberSeverity: "idle",
        liveSeverity: "working",
      }),
    ).toBe("working");
  });

  it("keeps worse rollup severity when live is only working", () => {
    const node = { ...base, type: "text", text: "worker" } as CanvasNode;
    expect(
      hotbarNodeSeverity(node, {
        memberSeverity: "blocked",
        liveSeverity: "working",
      }),
    ).toBe("blocked");
  });

  it("reads live severity alone for freestanding agents", () => {
    const node = { ...base, type: "text", text: "Pi" } as CanvasNode;
    expect(hotbarNodeSeverity(node, { liveSeverity: "attention" })).toBe("attention");
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

describe("liveActivitySeverity", () => {
  it("maps seat working and attention", () => {
    expect(liveActivitySeverity({ seatState: "working" })).toBe("working");
    expect(liveActivitySeverity({ seatState: "attention" })).toBe("attention");
    expect(liveActivitySeverity({ seatState: "idle" })).toBeUndefined();
  });

  it("maps herdr working and blocked", () => {
    expect(liveActivitySeverity({ herdrAgentStatus: "working" })).toBe("working");
    expect(liveActivitySeverity({ herdrAgentStatus: "blocked" })).toBe("blocked");
    expect(liveActivitySeverity({ herdrAgentStatus: "done" })).toBeUndefined();
  });
});

describe("worseMemberSeverity", () => {
  it("orders blocked over working over idle", () => {
    expect(worseMemberSeverity("working", "idle")).toBe("working");
    expect(worseMemberSeverity("blocked", "working")).toBe("blocked");
  });
});
