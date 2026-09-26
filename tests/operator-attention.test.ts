import { describe, expect, it } from "vitest";
import {
  attentionItemFromFacts,
  collectOperatorAttention,
  freestandingFromCanvasAttention,
  OPERATOR_ATTENTION_HEADLINE,
} from "../src/renderer/lib/operator-attention";
import type { SeatFacts } from "../src/renderer/lib/seat-projections";
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
    ready: members.filter((m) => m.severity === "ready").length,
  },
  members,
});

const facts = (
  nodeId: string,
  over: Partial<SeatFacts> = {},
): SeatFacts => ({ nodeId, ...over });

describe("collectOperatorAttention", () => {
  it("collects blocked and attention via notifyItem — not rollup severity", () => {
    const items = collectOperatorAttention(
      [
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
      ],
      new Map([
        ["a1", facts("a1", { seatState: "attention" })],
        ["a2", facts("a2", { graphBlocked: true })],
        ["a3", facts("a3", { seatState: "working" })],
      ]),
    );

    expect(items.map((i) => i.nodeId)).toEqual(["a2", "a1"]);
    expect(items[0]?.kind).toBe("blocked");
    expect(items[1]?.kind).toBe("attention");
    expect(OPERATOR_ATTENTION_HEADLINE.attention).toMatch(/OPERATOR INPUT/i);
    expect(OPERATOR_ATTENTION_HEADLINE.blocked).toMatch(/BLOCKED/i);
  });

  it("ignores rollup attention when facts are only working", () => {
    const items = collectOperatorAttention(
      [
        rollup([
          {
            nodeId: "grouped",
            label: "Grouped",
            kind: "agent",
            severity: "attention",
            reasons: ["activity:attention"],
          },
        ]),
      ],
      new Map([["grouped", facts("grouped", { seatState: "working" })]]),
    );
    expect(items).toEqual([]);
  });

  it("grouped live attention notifies even when rollup says working", () => {
    const items = collectOperatorAttention(
      [
        rollup([
          {
            nodeId: "g",
            label: "G",
            kind: "agent",
            severity: "working",
            reasons: ["activity:working"],
          },
        ]),
      ],
      new Map([["g", facts("g", { attentionReasons: ["permission:pending"] })]]),
    );
    expect(items).toEqual([
      expect.objectContaining({ nodeId: "g", kind: "attention" }),
    ]);
  });

  it("dedupes overlapping region members keeping the worst notify kind", () => {
    const factsByNode = new Map([
      ["shared", facts("shared", { graphBlocked: true, attentionReasons: ["permission:pending"] })],
    ]);
    const extra = [
      attentionItemFromFacts(factsByNode.get("shared")!, "second")!,
    ];
    const items = collectOperatorAttention(
      [
        rollup([
          {
            nodeId: "shared",
            label: "first",
            kind: "agent",
            severity: "attention",
            reasons: ["permission:pending"],
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
      ],
      factsByNode,
      extra,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      nodeId: "shared",
      kind: "blocked",
    });
  });

  it("returns empty when nothing needs the operator", () => {
    expect(
      collectOperatorAttention(
        [
          rollup([
            {
              nodeId: "idle",
              label: "quiet",
              kind: "agent",
              severity: "idle",
              reasons: [],
            },
          ]),
        ],
        new Map([["idle", facts("idle", { seatState: "idle" })]]),
      ),
    ).toEqual([]);
  });

  it("merges freestanding seats outside any region", () => {
    const items = collectOperatorAttention(
      [],
      new Map(),
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

describe("freestandingFromCanvasAttention", () => {
  it("surfaces graph-blocked nodes outside any region", () => {
    const items = freestandingFromCanvasAttention(
      [
        { id: "solo-blocked", label: "Solo seat" },
        { id: "idle", label: "Quiet" },
      ],
      new Map([
        ["solo-blocked", facts("solo-blocked", { graphBlocked: true })],
        ["idle", facts("idle", { seatState: "idle" })],
      ]),
      new Map([["solo-blocked", ["work:input-required"]]]),
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

  it("surfaces harness attention and live attention reasons for every node", () => {
    const items = freestandingFromCanvasAttention(
      [
        { id: "seat-attn", label: "Needs me" },
        { id: "flagged", label: "Flagged" },
        { id: "covered", label: "Also grouped" },
      ],
      new Map([
        ["seat-attn", facts("seat-attn", { seatState: "attention" })],
        ["flagged", facts("flagged", { attentionReasons: ["permission:pending"] })],
        ["covered", facts("covered", { attentionReasons: ["permission:pending"] })],
      ]),
    );
    expect(items.map((i) => i.nodeId).sort()).toEqual([
      "covered",
      "flagged",
      "seat-attn",
    ]);
    expect(items.find((i) => i.nodeId === "seat-attn")?.kind).toBe("attention");
    expect(items.find((i) => i.nodeId === "flagged")?.reasons).toContain(
      "permission:pending",
    );
  });

  it("does not notify working seats", () => {
    const items = freestandingFromCanvasAttention(
      [{ id: "busy", label: "Busy" }],
      new Map([["busy", facts("busy", { seatState: "working" })]]),
    );
    expect(items).toEqual([]);
  });

  it("notifies seat attention from the same facts as the card", () => {
    const items = freestandingFromCanvasAttention(
      [{ id: "needs-me", label: "Needs me" }],
      new Map([["needs-me", facts("needs-me", { seatState: "attention" })]]),
    );
    expect(items).toEqual([
      expect.objectContaining({
        nodeId: "needs-me",
        kind: "attention",
        reasons: ["activity:attention"],
      }),
    ]);
  });

  it("prefers blocked over attention for the same node", () => {
    const items = freestandingFromCanvasAttention(
      [{ id: "both", label: "Both" }],
      new Map([
        ["both", facts("both", { graphBlocked: true, attentionReasons: ["permission:pending"] })],
      ]),
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
      new Map([
        [
          "permission",
          facts("permission", { attentionReasons: ["permission:pending"] }),
        ],
        ["task", facts("task", { attentionReasons: ["work:input-required"] })],
      ]),
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
