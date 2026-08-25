import { describe, expect, it } from "vitest";
import type { MemberStatus, RegionRollup } from "../src/shared/region-rollup";
import { buildRollCall, rollCallBucketLabel } from "../src/renderer/lib/roll-call";

const member = (
  nodeId: string,
  severity: MemberStatus["severity"],
  reasons: ReadonlyArray<string> = [],
): MemberStatus => ({ nodeId, label: nodeId, kind: "agent", severity, reasons });

const rollup = (members: ReadonlyArray<MemberStatus>): RegionRollup => ({
  regionId: "r",
  label: "ops",
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

describe("buildRollCall", () => {
  it("surfaces ready as its own bucket, after working", () => {
    const model = buildRollCall(
      rollup([
        member("w", "working", ["activity:working"]),
        member("a", "ready", ["activity:ready"]),
        member("b", "ready", ["activity:ready"]),
        member("z", "idle"),
      ]),
    );
    expect(model.kind).toBe("hot");
    if (model.kind !== "hot") return;
    expect(model.buckets.map((bucket) => bucket.severity)).toEqual(["working", "ready"]);
    const ready = model.buckets.find((bucket) => bucket.severity === "ready");
    expect(ready?.count).toBe(2);
    expect(ready?.names).toEqual(["a", "b"]);
  });

  it("a region of finished seats is hot, not quiet", () => {
    const model = buildRollCall(rollup([member("a", "ready", ["activity:ready"])]));
    expect(model.kind).toBe("hot");
  });

  it("all-idle stays quiet", () => {
    expect(buildRollCall(rollup([member("a", "idle")])).kind).toBe("quiet");
    expect(buildRollCall(rollup([])).kind).toBe("empty");
  });

  it("recounts ready when a cached rollup predates the field", () => {
    const cached = rollup([member("a", "ready", ["activity:ready"])]);
    const legacy = {
      ...cached,
      counts: { total: 1, blocked: 0, attention: 0, working: 0 },
    } as unknown as RegionRollup;
    const model = buildRollCall(legacy);
    expect(model.kind).toBe("hot");
    if (model.kind !== "hot") return;
    expect(model.buckets[0]).toMatchObject({ severity: "ready", count: 1 });
  });
});

describe("rollCallBucketLabel", () => {
  it("says ready in full words, singular and plural", () => {
    expect(rollCallBucketLabel("ready", 1)).toBe("1 ready");
    expect(rollCallBucketLabel("ready", 4)).toBe("4 ready");
  });
});
