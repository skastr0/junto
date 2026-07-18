import { describe, expect, it } from "vitest";
import {
  deriveIdleHerdrQueue,
  isIdleHerdrNeedsYou,
  nextIdleHerdrNodeId,
  type IdleHerdrInput,
} from "../src/renderer/lib/idle-herdr-queue";

const herdr = (partial: Partial<IdleHerdrInput> & { readonly nodeId: string }): IdleHerdrInput => ({
  isHerdr: true,
  ...partial,
});

describe("isIdleHerdrNeedsYou", () => {
  it("ignores non-herdr nodes", () => {
    expect(
      isIdleHerdrNeedsYou({
        nodeId: "n1",
        isHerdr: false,
        agentStatus: "done",
        permissionPending: true,
      }),
    ).toBeNull();
  });

  it("permission beats done", () => {
    expect(
      isIdleHerdrNeedsYou(herdr({ nodeId: "a", agentStatus: "done", permissionPending: true })),
    ).toBe("permission");
  });

  it("done without pendingSeen is needs-you", () => {
    expect(isIdleHerdrNeedsYou(herdr({ nodeId: "a", agentStatus: "done" }))).toBe("done");
  });

  it("pendingSeen excludes done", () => {
    expect(
      isIdleHerdrNeedsYou(herdr({ nodeId: "a", agentStatus: "done", pendingSeen: true })),
    ).toBeNull();
  });

  it("idle / working / blocked / unknown invent nothing", () => {
    for (const agentStatus of ["idle", "working", "blocked", "unknown", undefined, null] as const) {
      expect(isIdleHerdrNeedsYou(herdr({ nodeId: "a", agentStatus }))).toBeNull();
    }
  });
});

describe("deriveIdleHerdrQueue", () => {
  it("returns empty when nothing needs you", () => {
    expect(
      deriveIdleHerdrQueue([
        herdr({ nodeId: "a", agentStatus: "idle" }),
        herdr({ nodeId: "b", agentStatus: "working" }),
        { nodeId: "c", isHerdr: false, agentStatus: "done" },
      ]),
    ).toEqual([]);
  });

  it("orders permission before done, stable within bucket", () => {
    const queue = deriveIdleHerdrQueue([
      herdr({ nodeId: "d1", agentStatus: "done" }),
      herdr({ nodeId: "p1", permissionPending: true }),
      herdr({ nodeId: "d2", agentStatus: "done" }),
      herdr({ nodeId: "p2", permissionPending: true, agentStatus: "done" }),
      herdr({ nodeId: "idle", agentStatus: "idle" }),
      herdr({ nodeId: "seen", agentStatus: "done", pendingSeen: true }),
    ]);
    expect(queue.map((e) => e.nodeId)).toEqual(["p1", "p2", "d1", "d2"]);
    expect(queue.map((e) => e.reason)).toEqual([
      "permission",
      "permission",
      "done",
      "done",
    ]);
  });

  it("preserves document order for pure done queue", () => {
    const queue = deriveIdleHerdrQueue([
      herdr({ nodeId: "z", agentStatus: "done" }),
      herdr({ nodeId: "a", agentStatus: "done" }),
      herdr({ nodeId: "m", agentStatus: "done" }),
    ]);
    expect(queue.map((e) => e.nodeId)).toEqual(["z", "a", "m"]);
  });
});

describe("nextIdleHerdrNodeId", () => {
  const queue = deriveIdleHerdrQueue([
    herdr({ nodeId: "a", agentStatus: "done" }),
    herdr({ nodeId: "b", agentStatus: "done" }),
    herdr({ nodeId: "c", agentStatus: "done" }),
  ]);

  it("returns undefined for empty queue", () => {
    expect(nextIdleHerdrNodeId([], "a")).toBeUndefined();
    expect(nextIdleHerdrNodeId([], undefined)).toBeUndefined();
  });

  it("starts at first when current is missing or not in queue", () => {
    expect(nextIdleHerdrNodeId(queue, undefined)).toBe("a");
    expect(nextIdleHerdrNodeId(queue, null)).toBe("a");
    expect(nextIdleHerdrNodeId(queue, "other")).toBe("a");
  });

  it("cycles to next and wraps", () => {
    expect(nextIdleHerdrNodeId(queue, "a")).toBe("b");
    expect(nextIdleHerdrNodeId(queue, "b")).toBe("c");
    expect(nextIdleHerdrNodeId(queue, "c")).toBe("a");
  });

  it("single-item queue always returns that node", () => {
    const one = deriveIdleHerdrQueue([herdr({ nodeId: "only", agentStatus: "done" })]);
    expect(nextIdleHerdrNodeId(one, undefined)).toBe("only");
    expect(nextIdleHerdrNodeId(one, "only")).toBe("only");
  });
});
