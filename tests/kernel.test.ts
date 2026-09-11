import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc, EtherWatch } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { groupMembers } from "../src/shared/graph";
import {
  detectPulses,
  evaluateWatcher,
  resetWatcherMemory,
} from "../src/main/vellum-command/kernel/evaluate";

// --- fixtures ----------------------------------------------------------------

const EMPTY_SNAPSHOTS: SnapshotState = { bundles: [] };

const snapshotsWithStat = (stat: string, value: number | string): SnapshotState => ({
  bundles: [
    {
      source: "hermes",
      fetchedAt: new Date().toISOString(),
      ok: true,
      entities: [
        {
          source: "hermes",
          key: "proj",
          kind: "project",
          stats: { [stat]: value },
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  ],
});

const STAT_WATCH: EtherWatch = {
  kind: "stat_threshold",
  source: "hermes",
  key: "proj",
  stat: "signals",
  op: "gt",
  value: 10,
};

afterEach(() => {
  resetWatcherMemory();
});

// --- stat_threshold --------------------------------------------------------------

describe("evaluateWatcher — stat_threshold", () => {
  const canvasName = "test-canvas";

  it("is unknown when the bound entity is missing", () => {
    const result = evaluateWatcher(canvasName, "w1", STAT_WATCH, EMPTY_SNAPSHOTS);
    expect(result.state.status).toBe("unknown");
  });

  it("is satisfied when the stat crosses the threshold, with a readable detail", () => {
    const result = evaluateWatcher(canvasName, "w1", STAT_WATCH, snapshotsWithStat("signals", 34));
    expect(result.state).toEqual({ status: "satisfied", detail: "signals 34 > 10" });
  });

  it("is pending when the stat hasn't crossed the threshold", () => {
    const result = evaluateWatcher(canvasName, "w1", STAT_WATCH, snapshotsWithStat("signals", 3));
    expect(result.state).toEqual({ status: "pending", detail: "signals 3 > 10" });
  });
});

// --- level-rule rising-edge (status transition; no pulse inject) -----------------

describe("evaluateWatcher — level rules only fire on a rising edge into satisfied", () => {
  const canvasName = "test-canvas";

  it("never fires on a watcher's first evaluation, even if already satisfied", () => {
    const result = evaluateWatcher(canvasName, "w1", STAT_WATCH, snapshotsWithStat("signals", 34));
    expect(result.state.status).toBe("satisfied");
    expect(result.fired).toBe(false);
  });

  it("fires when status transitions from pending to satisfied on a later pass", () => {
    evaluateWatcher(canvasName, "w1", STAT_WATCH, snapshotsWithStat("signals", 3));
    const result = evaluateWatcher(canvasName, "w1", STAT_WATCH, snapshotsWithStat("signals", 34));
    expect(result.fired).toBe(true);
  });
});

// --- detectPulses ------------------------------------------------------------------

describe("detectPulses", () => {
  const canvasName = "test-canvas";

  it("evaluates every watcher node in the doc and reports which ones fired", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "watcher-1", type: "text", text: "watcher", x: 0, y: 0, width: 100, height: 40,
          ether: { entity: { kind: "watcher" }, watch: STAT_WATCH },
        },
        { id: "plain-note", type: "text", text: "just a note", x: 200, y: 0, width: 100, height: 40 },
      ],
      edges: [],
    };
    const results = detectPulses(canvasName, doc, snapshotsWithStat("signals", 34));
    expect(results).toHaveLength(1);
    expect(results[0]?.nodeId).toBe("watcher-1");
    expect(results[0]?.result.state.status).toBe("satisfied");
    expect(results[0]?.result.fired).toBe(false); // baseline
  });
});

// --- I9: one membership authority (geometry; no pulse delivery) ------------------
// Region 0,0,400,400. "straddler"'s CENTER (375,375) lies inside the region,
// but its full rect extends past the right/bottom edge (300+150=450 > 400).
// Full-rect containment (shared/graph.ts groupMembers) must exclude it.

describe("I9 — single membership authority: full-rect containment", () => {
  const regionId = "region-partial";
  const doc: CanvasDoc = {
    nodes: [
      { id: regionId, type: "group", x: 0, y: 0, width: 400, height: 400 },
      {
        id: "agent-inside",
        type: "text",
        text: "agent inside",
        x: 50,
        y: 50,
        width: 100,
        height: 50,
        ether: {
          entity: { kind: "agent", name: "remote-a:inside" },
          terminal: {
            bindingId: "bind-remote-a-inside",
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        },
      },
      {
        id: "agent-straddler",
        type: "text",
        text: "agent straddler",
        x: 300,
        y: 300,
        width: 150,
        height: 150,
        ether: {
          entity: { kind: "agent", name: "remote-a:straddler" },
          terminal: {
            bindingId: "bind-remote-a-straddler",
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        },
      },
    ],
    edges: [],
  };

  it("groupMembers excludes the straddler", () => {
    expect(groupMembers(doc).get(regionId)).toEqual(["agent-inside"]);
  });
});
