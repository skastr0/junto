import { describe, expect, it } from "vitest";
import {
  collectOperatorAttention,
  freestandingFromCanvasAttention,
  freestandingFromTerminalStatus,
  OPERATOR_ATTENTION_HEADLINE,
} from "../src/renderer/lib/operator-attention";
import type { RegionRollup } from "../src/shared/region-rollup";

const rollup = (
  members: RegionRollup["members"],
  regionId = "r1",
): RegionRollup => ({
  regionId,
  label: "forge",
  severity: members[0]?.severity ?? "idle",
  counts: {
    total: members.length,
    blocked: members.filter((m) => m.severity === "blocked").length,
    attention: members.filter((m) => m.severity === "attention").length,
    working: members.filter((m) => m.severity === "working").length,
  },
  members,
});

describe("collectOperatorAttention", () => {
  it("collects blocked and attention only — permanent, not rising-edge", () => {
    const items = collectOperatorAttention([
      rollup([
        {
          nodeId: "a1",
          label: "Codex - needs input",
          kind: "agent",
          severity: "attention",
          reasons: ["activity:attention"],
        },
        {
          nodeId: "a2",
          label: "blocked worker",
          kind: "agent",
          severity: "blocked",
          reasons: ["work:input-required"],
        },
        {
          nodeId: "a3",
          label: "busy",
          kind: "agent",
          severity: "working",
          reasons: ["activity:working"],
        },
      ]),
    ]);

    expect(items.map((i) => i.nodeId)).toEqual(["a2", "a1"]);
    expect(items[0]?.kind).toBe("blocked");
    expect(items[1]?.kind).toBe("attention");
    expect(OPERATOR_ATTENTION_HEADLINE.attention).toMatch(/OPERATOR INPUT/i);
    expect(OPERATOR_ATTENTION_HEADLINE.blocked).toMatch(/BLOCKED/i);
  });

  it("dedupes overlapping region members keeping the worst severity", () => {
    const items = collectOperatorAttention([
      rollup([
        {
          nodeId: "shared",
          label: "first",
          kind: "agent",
          severity: "attention",
          reasons: ["flag:attention"],
        },
      ]),
      rollup(
        [
          {
            nodeId: "shared",
            label: "second",
            kind: "agent",
            severity: "blocked",
            reasons: ["edge:input-required"],
          },
        ],
        "r2",
      ),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      nodeId: "shared",
      kind: "blocked",
      label: "second",
    });
  });

  it("returns empty when nothing needs the operator", () => {
    expect(
      collectOperatorAttention([
        rollup([
          {
            nodeId: "idle",
            label: "quiet",
            kind: "agent",
            severity: "idle",
            reasons: [],
          },
        ]),
      ]),
    ).toEqual([]);
  });

  it("merges freestanding seats outside any region", () => {
    const items = collectOperatorAttention(
      [],
      [
        {
          id: "op-attn:solo",
          nodeId: "solo",
          kind: "attention",
          label: "solo agent",
          reasons: ["activity:attention"],
        },
      ],
    );
    expect(items).toEqual([
      expect.objectContaining({ nodeId: "solo", kind: "attention", label: "solo agent" }),
    ]);
  });
});

describe("freestandingFromTerminalStatus", () => {
  it("skips nodes already covered by rollups", () => {
    const map = new Map([
      ["a", { harness: "attention" as const }],
      ["b", { harness: "blocked" as const }],
    ]);
    const items = freestandingFromTerminalStatus(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      map,
      new Set(["a"]),
    );
    expect(items).toEqual([
      expect.objectContaining({ nodeId: "b", kind: "blocked" }),
    ]);
  });
});

describe("freestandingFromCanvasAttention", () => {
  it("surfaces graph-blocked nodes outside any region", () => {
    const items = freestandingFromCanvasAttention(
      [
        { id: "solo-blocked", label: "Solo seat" },
        { id: "idle", label: "Quiet" },
      ],
      {
        blockedNodeIds: new Set(["solo-blocked"]),
        blockedReasonsByNodeId: new Map([
          ["solo-blocked", ["work:input-required"]],
        ]),
      },
    );
    expect(items).toEqual([
      expect.objectContaining({
        nodeId: "solo-blocked",
        kind: "blocked",
        label: "Solo seat",
        reasons: ["work:input-required"],
      }),
    ]);
  });

  it("surfaces harness attention and flag:attention when not covered", () => {
    const terminal = new Map([
      ["seat-attn", { harness: "attention" as const }],
    ]);
    const items = freestandingFromCanvasAttention(
      [
        { id: "seat-attn", label: "Needs me" },
        { id: "flagged", label: "Flagged", flags: ["attention"] },
        { id: "covered", label: "Already in rollup", flags: ["attention"] },
      ],
      {
        blockedNodeIds: new Set(),
        terminalStatusByNodeId: terminal,
        alreadyCovered: new Set(["covered"]),
      },
    );
    expect(items.map((i) => i.nodeId).sort()).toEqual(["flagged", "seat-attn"]);
    expect(items.find((i) => i.nodeId === "seat-attn")?.kind).toBe("attention");
    expect(items.find((i) => i.nodeId === "flagged")?.reasons).toContain(
      "flag:attention",
    );
  });

  it("prefers blocked over attention for the same node", () => {
    const items = freestandingFromCanvasAttention(
      [{ id: "both", label: "Both", flags: ["attention"] }],
      {
        blockedNodeIds: new Set(["both"]),
        terminalStatusByNodeId: new Map([
          ["both", { harness: "attention" }],
        ]),
      },
    );
    expect(items).toEqual([
      expect.objectContaining({ nodeId: "both", kind: "blocked" }),
    ]);
  });

  it("surfaces live attention reasons outside every region", () => {
    const items = freestandingFromCanvasAttention(
      [
        { id: "permission", label: "Agent permission" },
        { id: "task", label: "Task queue" },
      ],
      {
        blockedNodeIds: new Set(),
        attentionReasonsByNodeId: new Map([
          ["permission", ["permission:pending"]],
          ["task", ["work:input-required"]],
        ]),
      },
    );

    expect(items).toEqual([
      expect.objectContaining({
        nodeId: "permission",
        kind: "attention",
        reasons: ["permission:pending"],
      }),
      expect.objectContaining({
        nodeId: "task",
        kind: "attention",
        reasons: ["work:input-required"],
      }),
    ]);
  });
});
