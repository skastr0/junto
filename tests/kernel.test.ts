import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc, EtherWatch } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { groupMembers } from "../src/shared/graph";
import {
  detectPulses,
  evaluateWatcher,
  resetWatcherMemory,
} from "../src/main/vellum/kernel/evaluate";
import {
  composePulseMessage,
  deliverPulse,
  MIN_LIVE_PULSE_SPACING_MS,
  type PulseDeliverDeps,
  __setDocsForTest,
  __setSnapshotsForTest,
  setArmed,
  getPulseLog,
  __resetPulseLogForTest,
  __setDeliveryDepsForTest,
  __setStationScopeForTest,
} from "../src/main/vellum/kernel/cycle";

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

// --- level-rule rising-edge (drives whether a watcher pulses a region) -----------

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

// --- composePulseMessage -----------------------------------------------------------

describe("composePulseMessage", () => {
  it("wraps the summary alone when there is no region instruction", () => {
    expect(composePulseMessage("3/5 done")).toBe("[pulse] 3/5 done");
  });

  it("appends the region instruction on a blank line when present", () => {
    expect(composePulseMessage("3/5 done", "ship the release")).toBe("[pulse] 3/5 done\n\nship the release");
  });
});

// --- deliverPulse: arming, spacing, regionless — no chat calls -------------------

describe("deliverPulse — arming and live-pulse spacing", () => {
  const regionId = "region-cap-test";
  const canvasName = "test-canvas";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
    __resetPulseLogForTest();
    __setStationScopeForTest({ hostId: "local", role: "command-center" });
    __setDocsForTest(
      new Map([
        [
          canvasName,
          {
            nodes: [
              {
                id: regionId,
                type: "group",
                x: 0,
                y: 0,
                width: 400,
                height: 400,
              },
              {
                id: "spacing-agent",
                type: "text",
                text: "spacing agent",
                x: 40,
                y: 40,
                width: 120,
                height: 60,
                ether: {
                  entity: { kind: "agent", name: "local:spacing" },
                  terminal: {
                    bindingId: "bind-local-spacing",
                    harness: "claude",
                    launch: { kind: "harness", argv: ["claude"] },
                  },
                },
              },
            ],
            edges: [],
          },
        ],
      ]),
    );
    // Set default deps that simulate successful delivery when arming is true
    const defaultDeps: PulseDeliverDeps = {
      sendManagedTerminal: async () => true,
    };
    __setDeliveryDepsForTest(defaultDeps);
  });

  afterEach(() => {
    __setDeliveryDepsForTest(undefined);
    vi.useRealTimers();
  });

  it("stays live (non-dry) at a 5-minute-or-slower cadence", async () => {
    __resetPulseLogForTest();
    setArmed(`${canvasName}::${regionId}`, true);
    for (let i = 0; i < 3; i += 1) {
      await deliverPulse({ canvasName, sourceNodeId: `n${i}`, kind: "manual", regionId, summary: `pulse ${i}` });
      vi.setSystemTime(Date.now() + MIN_LIVE_PULSE_SPACING_MS);
    }
    const log = getPulseLog();
    expect(log).toHaveLength(3);
    expect(log.every((record) => record.dry === false)).toBe(true);
  });

  it("forces a delivery inside the spacing window to dry, with a cooldown note", async () => {
    __resetPulseLogForTest();
    setArmed(`${canvasName}::${regionId}`, true);
    await deliverPulse({ canvasName, sourceNodeId: "n0", kind: "manual", regionId, summary: "pulse 0" });
    vi.setSystemTime(Date.now() + 1_000); // one second later — the catastrophe cadence
    await deliverPulse({ canvasName, sourceNodeId: "n-over", kind: "manual", regionId, summary: "one too soon" });

    const log = getPulseLog();
    expect(log).toHaveLength(2);
    const last = log[log.length - 1];
    expect(last?.dry).toBe(true);
    expect(last?.summary).toContain("cooldown");
  });

  it("a disarmed region always logs dry with nothing delivered", async () => {
    __resetPulseLogForTest();
    setArmed(`${canvasName}::${regionId}`, false);
    await deliverPulse({ canvasName, sourceNodeId: "n", kind: "manual", regionId, summary: "quiet" });
    const record = getPulseLog()[0];
    expect(record?.dry).toBe(true);
    expect(record?.delivered).toEqual([]);
  });

  it("a regionless pulse always logs dry with delivered: [] and no regionId", async () => {
    __resetPulseLogForTest();
    await deliverPulse({ canvasName, sourceNodeId: "n", kind: "watcher", regionId: undefined, summary: "no region" });
    const record = getPulseLog()[0];
    expect(record?.dry).toBe(true);
    expect(record?.regionId).toBeUndefined();
    expect(record?.delivered).toEqual([]);
  });

  it("forceDry short-circuits an armed, under-cap region straight to dry", async () => {
    __resetPulseLogForTest();
    setArmed(`${canvasName}::${regionId}`, true);
    await deliverPulse({ canvasName, sourceNodeId: "n", kind: "manual", regionId, summary: "manual dry run", forceDry: true });
    const record = getPulseLog()[0];
    expect(record?.dry).toBe(true);
    expect(record?.summary).toBe("manual dry run");
  });
});

// --- deliverPulse: injected delivery, sequential per-agent ------------------------

describe("deliverPulse — injected delivery fn (no real chat calls)", () => {
  const regionId = "region-agents";
  const canvasName = "test-canvas";
  const agentDoc: CanvasDoc = {
    nodes: [
      { id: regionId, type: "group", x: 0, y: 0, width: 400, height: 400 },
      {
        id: "agent-a",
        type: "text",
        text: "agent a",
        x: 50,
        y: 50,
        width: 100,
        height: 50,
        ether: {
          entity: { kind: "agent", name: "remote-a:vega" },
          terminal: {
            bindingId: "bind-remote-a-vega",
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        },
      },
      {
        id: "agent-b",
        type: "text",
        text: "agent b",
        x: 200,
        y: 200,
        width: 100,
        height: 50,
        ether: {
          entity: { kind: "agent", name: "remote-a:nova" },
          terminal: {
            bindingId: "bind-remote-a-nova",
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        },
      },
      // Outside the region's rect — must never receive a pulse.
      {
        id: "agent-c",
        type: "text",
        text: "agent c",
        x: 900,
        y: 900,
        width: 100,
        height: 50,
        ether: {
          entity: { kind: "agent", name: "remote-a:outside" },
          terminal: {
            bindingId: "bind-remote-a-outside",
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        },
      },
    ],
    edges: [],
  };

  beforeEach(() => {
    __setStationScopeForTest({ hostId: "local", role: "command-center" });
    __resetPulseLogForTest();
    __setDocsForTest(new Map([[canvasName, agentDoc]]));
    setArmed(`${canvasName}::${regionId}`, true);
  });

  afterEach(() => {
    __setDeliveryDepsForTest(undefined);
  });

  it("delivers to every managed agent member via terminal binding", async () => {
    const calls: string[] = [];
    const deps: PulseDeliverDeps = {
      sendManagedTerminal: async (bindingId, message) => {
        calls.push(`send:${bindingId}:${message}`);
        return true;
      },
    };

    await deliverPulse({ canvasName, sourceNodeId: regionId, kind: "manual", regionId, summary: "go", deps });

    expect(calls.some((c) => c.includes("bind-remote-a-vega") && c.includes("[pulse] go"))).toBe(true);
    expect(calls.some((c) => c.includes("bind-remote-a-nova") && c.includes("[pulse] go"))).toBe(true);
    const record = getPulseLog()[0];
    expect(record?.dry).toBe(false);
    expect(record?.delivered).toEqual(["remote-a:vega", "remote-a:nova"]);
  });

  it("one agent's delivery failure doesn't sink the rest", async () => {
    const deps: PulseDeliverDeps = {
      sendManagedTerminal: async (bindingId) => {
        if (bindingId.includes("vega")) throw new Error("boom");
        return true;
      },
    };
    await deliverPulse({ canvasName, sourceNodeId: regionId, kind: "manual", regionId, summary: "go", deps });
    const record = getPulseLog()[0];
    expect(record?.delivered).toEqual(["remote-a:nova"]);
  });
});

// --- I9: one membership authority — kernel path matches rollup path --------------
// Region 0,0,400,400. "straddler"'s CENTER (375,375) lies inside the region,
// but its full rect extends past the right/bottom edge (300+150=450 > 400).
// Full-rect containment (the single authority, shared/graph.ts groupMembers)
// must exclude it everywhere — proven here via two independent call paths:
// the shared function directly (the rollup/digest/work path) and kernel
// pulse delivery (agentKeysInRegion, routed through the same groupMembers).
describe("I9 — single membership authority: kernel path matches rollup path", () => {
  const canvasName = "test-canvas";
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

  it("rollup path (groupMembers) excludes the straddler", () => {
    expect(groupMembers(doc).get(regionId)).toEqual(["agent-inside"]);
  });

  it("kernel path (deliverPulse) excludes the straddler identically", async () => {
    __setStationScopeForTest({ hostId: "local", role: "command-center" });
    __resetPulseLogForTest();
    __setDocsForTest(new Map([[canvasName, doc]]));
    setArmed(`${canvasName}::${regionId}`, true);
    const deps: PulseDeliverDeps = { sendManagedTerminal: async () => true };
    await deliverPulse({ canvasName, sourceNodeId: regionId, kind: "manual", regionId, summary: "go", deps });
    const record = getPulseLog()[0];
    expect(record?.delivered).toEqual(["remote-a:inside"]);
    __setDeliveryDepsForTest(undefined);
  });
});

// --- I14: scheduler pulses route via edges; geometry never mints a route -------
// Watcher/timer delivery uses agentKeysForExecutableSource (human-authored edges).
// Region geometry supplies evaluation context + the *manual* pulse audience only.
// Membership for that audience is the single shared groupMembers (I9 / S1).
describe("I14 — pulse delivery: edges route; geometry does not mint", () => {
  const canvasName = "i14-canvas";
  const regionId = "region-i14";
  const watcherId = "watcher-i14";
  const timerId = "timer-i14";

  const baseNodes = (): CanvasDoc["nodes"] => [
    {
      id: regionId,
      type: "group",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      ether: { region: { instruction: "brief the floor" } },
    },
    {
      id: watcherId,
      type: "text",
      text: "watch",
      x: 20,
      y: 20,
      width: 100,
      height: 40,
      ether: {
        entity: { kind: "watcher" },
        watch: {
          kind: "stat_threshold",
          source: "hermes",
          key: "proj",
          stat: "signals",
          op: "gt",
          value: 10,
        },
      },
    },
    {
      id: timerId,
      type: "text",
      text: "timer",
      x: 20,
      y: 80,
      width: 100,
      height: 40,
      ether: { entity: { kind: "timer" }, timer: { everyMinutes: 15 } },
    },
    // In-region, no edge — must NOT receive watcher/timer pulses.
    {
      id: "agent-inedged",
      type: "text",
      text: "in region no edge",
      x: 50,
      y: 200,
      width: 100,
      height: 50,
      ether: {
          entity: { kind: "agent", name: "local:in-region-no-edge" },
          terminal: {
            bindingId: "bind-local-in-region-no-edge",
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        },
    },
    // In-region, edged from watcher.
    {
      id: "agent-inedged-w",
      type: "text",
      text: "in region edged",
      x: 200,
      y: 200,
      width: 100,
      height: 50,
      ether: {
          entity: { kind: "agent", name: "local:in-region-edged" },
          terminal: {
            bindingId: "bind-local-in-region-edged",
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        },
    },
    // Outside region, edged from watcher — still receives (geometry is not the router).
    {
      id: "agent-out-edged",
      type: "text",
      text: "outside edged",
      x: 900,
      y: 900,
      width: 100,
      height: 50,
      ether: {
          entity: { kind: "agent", name: "local:outside-edged" },
          terminal: {
            bindingId: "bind-local-outside-edged",
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        },
    },
    // Outside region, no edge — never receives.
    {
      id: "agent-out-none",
      type: "text",
      text: "outside none",
      x: 1100,
      y: 900,
      width: 100,
      height: 50,
      ether: {
          entity: { kind: "agent", name: "local:outside-no-edge" },
          terminal: {
            bindingId: "bind-local-outside-no-edge",
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        },
    },
  ];

  const recordingDeps = () => {
    const sent: string[] = [];
    const deps: PulseDeliverDeps = {
      sendManagedTerminal: async (bindingId) => {
        sent.push(bindingId);
        return true;
      },
    };
    return { deps, sent };
  };

  beforeEach(() => {
    __setStationScopeForTest({ hostId: "local", role: "command-center" });
    __resetPulseLogForTest();
    setArmed(`${canvasName}::${regionId}`, true);
  });

  afterEach(() => {
    __setDeliveryDepsForTest(undefined);
  });

  it("watcher fire: in-region actor without an edge receives nothing", async () => {
    const doc: CanvasDoc = {
      nodes: baseNodes(),
      // No edges at all — geometry alone must not mint delivery.
      edges: [],
    };
    __setDocsForTest(new Map([[canvasName, doc]]));
    const { deps, sent } = recordingDeps();

    await deliverPulse({
      canvasName,
      sourceNodeId: watcherId,
      kind: "watcher",
      regionId,
      summary: "threshold crossed",
      deps,
    });

    const record = getPulseLog()[0];
    expect(record?.dry).toBe(true);
    expect(record?.kind).toBe("watcher");
    expect(record?.delivered).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("watcher fire: edged actors receive the pulse whether in or out of the region", async () => {
    const doc: CanvasDoc = {
      nodes: baseNodes(),
      edges: [
        { id: "e-in", fromNode: watcherId, toNode: "agent-inedged-w" },
        { id: "e-out", fromNode: watcherId, toNode: "agent-out-edged" },
      ],
    };
    __setDocsForTest(new Map([[canvasName, doc]]));
    const { deps, sent } = recordingDeps();

    await deliverPulse({
      canvasName,
      sourceNodeId: watcherId,
      kind: "watcher",
      regionId,
      summary: "threshold crossed",
      deps,
    });

    const record = getPulseLog()[0];
    expect(record?.dry).toBe(false);
    // In-region unedged and outside unedged stay dark.
    expect(record?.delivered).toEqual(
      expect.arrayContaining(["local:in-region-edged", "local:outside-edged"]),
    );
    expect(record?.delivered).toHaveLength(2);
    expect(record?.delivered).not.toContain("local:in-region-no-edge");
    expect(record?.delivered).not.toContain("local:outside-no-edge");
    expect(sent).toHaveLength(2);
    expect(sent.every((b) => b.startsWith("bind-"))).toBe(true);
  });

  it("timer fire: same edge-only routing (geometry does not mint)", async () => {
    const doc: CanvasDoc = {
      nodes: baseNodes(),
      edges: [{ id: "e-timer", fromNode: timerId, toNode: "agent-out-edged" }],
    };
    __setDocsForTest(new Map([[canvasName, doc]]));
    const { deps, sent } = recordingDeps();

    await deliverPulse({
      canvasName,
      sourceNodeId: timerId,
      kind: "timer",
      regionId,
      summary: "timer fired · every 15m",
      deps,
    });

    const record = getPulseLog()[0];
    expect(record?.dry).toBe(false);
    expect(record?.kind).toBe("timer");
    expect(record?.delivered).toEqual(["local:outside-edged"]);
    expect(sent).toEqual(["bind-local-outside-edged"]);
  });

  it("manual region pulse still reaches eligible members (operator action, unchanged)", async () => {
    const doc: CanvasDoc = {
      nodes: baseNodes(),
      // No edges — manual falls back to agentKeysInRegion / groupMembers.
      edges: [],
    };
    __setDocsForTest(new Map([[canvasName, doc]]));
    const { deps, sent } = recordingDeps();

    await deliverPulse({
      canvasName,
      sourceNodeId: regionId,
      kind: "manual",
      regionId,
      summary: "manual pulse",
      deps,
    });

    const record = getPulseLog()[0];
    expect(record?.dry).toBe(false);
    expect(record?.kind).toBe("manual");
    // Full-rect members only — outside agents never, even with no edges.
    expect(record?.delivered).toEqual(
      expect.arrayContaining(["local:in-region-no-edge", "local:in-region-edged"]),
    );
    expect(record?.delivered).toHaveLength(2);
    expect(record?.delivered).not.toContain("local:outside-edged");
    expect(record?.delivered).not.toContain("local:outside-no-edge");
    expect(sent).toHaveLength(2);
    expect(sent.every((b) => b.startsWith("bind-"))).toBe(true);
  });
});
