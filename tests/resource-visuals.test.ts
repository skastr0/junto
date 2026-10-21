import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ARTIFACT_TYPES,
  MARK_TONES,
  RESOURCE_KINDS,
  RESOURCE_KIND_VISUAL,
  STAMP_SLOTS,
  STAMP_SLOT_VISUAL,
  TASK_STATES,
  TASK_STATE_VISUAL,
  isOpenTaskState,
  markColor,
  stampSummary,
  stampTally,
  type ArtifactType,
  type MarkTone,
  type ResourceKind,
  type StampSlot,
  type TaskStateV10,
} from "../src/renderer/lib/resource-visuals";

describe("the visual tables are total over their closed unions", () => {
  it("draws every resource kind, each with its own mark hue", () => {
    expect(Object.keys(RESOURCE_KIND_VISUAL).sort()).toEqual([...RESOURCE_KINDS].sort());
    const tones = RESOURCE_KINDS.map((kind) => RESOURCE_KIND_VISUAL[kind].tone);
    expect(new Set(tones).size).toBe(RESOURCE_KINDS.length);
  });

  it("draws every task state", () => {
    expect(Object.keys(TASK_STATE_VISUAL).sort()).toEqual([...TASK_STATES].sort());
  });

  it("never gives a task state the blocker hue", () => {
    for (const state of TASK_STATES) expect(TASK_STATE_VISUAL[state].tone).not.toBe("crimson");
  });

  it("tells task states apart by shape as well as hue", () => {
    const glyphs = TASK_STATES.map((state) => TASK_STATE_VISUAL[state].glyph);
    expect(new Set(glyphs).size).toBe(TASK_STATES.length);
  });

  it("pulses only the state where work is moving", () => {
    expect(TASK_STATES.filter((state) => TASK_STATE_VISUAL[state].live)).toEqual(["working"]);
  });

  it("draws every stamp slot, dashed exactly when it is not a ruled fact", () => {
    expect(Object.keys(STAMP_SLOT_VISUAL).sort()).toEqual([...STAMP_SLOTS].sort());
    expect(STAMP_SLOTS.filter((slot) => STAMP_SLOT_VISUAL[slot].dashed)).toEqual(["pending", "stale"]);
  });

  it("names a token for every mark hue", () => {
    for (const tone of MARK_TONES) expect(markColor(tone)).toBe(`var(--color-${tone})`);
  });

  it("holds a seat for the states that hold one", () => {
    expect(TASK_STATES.filter(isOpenTaskState)).toEqual(["assigned", "working", "input-required", "in-review"]);
  });
});

describe("stampTally", () => {
  const approve = { verdict: "approve", epoch: 2 } as const;

  it("is met with no policy and draws nothing", () => {
    const tally = stampTally(0, [], 1);
    expect(tally.met).toBe(true);
    expect(tally.slots).toEqual([]);
    expect(stampSummary(tally)).toBe("No review required");
  });

  it("fills ruled approvals first and leaves the rest waiting", () => {
    const tally = stampTally(3, [approve], 2);
    expect(tally.slots).toEqual(["approved", "waiting", "waiting"]);
    expect(tally.met).toBe(false);
    expect(stampSummary(tally)).toBe("1 of 3 approved");
  });

  it("counts an approval at the current epoch only", () => {
    const tally = stampTally(1, [{ verdict: "approve", epoch: 1 }], 2);
    expect(tally.approved).toBe(0);
    expect(tally.stale).toBe(1);
    expect(tally.slots).toEqual(["waiting", "stale"]);
    expect(tally.met).toBe(false);
  });

  it("never lets a queued approval meet the policy", () => {
    const tally = stampTally(2, [approve, { ...approve, pending: true }], 2);
    expect(tally.met).toBe(false);
    expect(tally.slots).toEqual(["approved", "pending"]);
    expect(stampSummary(tally)).toBe("2 of 2 approvals pending");
  });

  it("shows a request for changes and says so", () => {
    const tally = stampTally(2, [approve, { verdict: "changes", epoch: 2 }], 2);
    expect(tally.slots).toEqual(["approved", "changes", "waiting"]);
    expect(stampSummary(tally)).toBe("1 of 2 approved, changes asked");
  });

  it("is met when ruled approvals reach the policy, extra ones included", () => {
    const tally = stampTally(1, [approve, approve], 2);
    expect(tally.met).toBe(true);
    expect(tally.slots).toEqual(["approved", "approved"]);
  });
});

describe("closed unions", () => {
  it("fix the sets", () => {
    expectTypeOf<ResourceKind>().toEqualTypeOf<"seat" | "task" | "artifact" | "page">();
    expectTypeOf<ArtifactType>().toEqualTypeOf<"link" | "document" | "pad" | "sheet" | "file">();
    expectTypeOf<TaskStateV10>().toEqualTypeOf<
      "backlog" | "assigned" | "working" | "input-required" | "in-review" | "done" | "canceled" | "archived"
    >();
    expectTypeOf<StampSlot>().toEqualTypeOf<"approved" | "changes" | "pending" | "waiting" | "stale">();
  });

  it("refuse a state or hue the tables do not name", () => {
    // @ts-expect-error: "failed" left the task model in 0.10.
    const failed: TaskStateV10 = "failed";
    // @ts-expect-error: an open string cannot stand in for the closed set.
    const open: ResourceKind = String("seat");
    // @ts-expect-error: pink is not a mark hue of this language.
    const pink: MarkTone = "pink";
    expect([failed, open, pink]).toHaveLength(3);
  });
});
