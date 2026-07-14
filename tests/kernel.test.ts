import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc, EtherWatch } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import type { TowerGlyphRow } from "../src/shared/ipc";
import {
  detectPulses,
  evaluateWatcher,
  resetWatcherMemory,
  type GlyphIndex,
} from "../src/main/vellum/kernel/evaluate";
import {
  composePulseMessage,
  deliverPulse,
  PULSE_CAP_PER_REGION_PER_HOUR,
  type PulseDeliverDeps,
  __setDocsForTest,
  __setSnapshotsForTest,
  setArmed,
  getPulseLog,
  __resetPulseLogForTest,
  __setDeliveryDepsForTest,
} from "../src/main/vellum/kernel/cycle";

// --- fixtures ----------------------------------------------------------------

const EMPTY_SNAPSHOTS: SnapshotState = { bundles: [] };

const glyphRow = (overrides: Partial<TowerGlyphRow> & { glyphId: string; state: string }): TowerGlyphRow => ({
  orbit: "forge",
  title: "ship it",
  updatedAt: Date.now(),
  ...overrides,
});

const glyphIndexOf = (project: string, rows: ReadonlyArray<TowerGlyphRow>): GlyphIndex => new Map([[project, rows]]);

const snapshotsWithStat = (stat: string, value: number | string): SnapshotState => ({
  bundles: [
    {
      source: "tower",
      fetchedAt: new Date().toISOString(),
      ok: true,
      entities: [
        {
          source: "tower",
          key: "proj",
          kind: "project",
          stats: { [stat]: value },
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  ],
});

afterEach(() => {
  resetWatcherMemory();
});

// --- glyphs_done ---------------------------------------------------------------

describe("evaluateWatcher — glyphs_done", () => {
  const watch: EtherWatch = { kind: "glyphs_done", project: "proj" };
  const canvasName = "test-canvas";

  it("is unknown when the project isn't in the glyph index (cache miss)", () => {
    const result = evaluateWatcher(canvasName, "w1", watch, EMPTY_SNAPSHOTS, new Map());
    expect(result.state).toEqual({ status: "unknown", detail: "glyph data unavailable" });
  });

  it("is unknown, not vacuously satisfied, when scope resolves to zero glyphs", () => {
    const result = evaluateWatcher(canvasName, "w1", watch, EMPTY_SNAPSHOTS, glyphIndexOf("proj", []));
    expect(result.state.status).toBe("unknown");
  });

  it("is pending with an N/M detail when some scoped glyphs aren't done", () => {
    const rows = [
      glyphRow({ glyphId: "g1", state: "done" }),
      glyphRow({ glyphId: "g2", state: "done" }),
      glyphRow({ glyphId: "g3", state: "building" }),
    ];
    const result = evaluateWatcher(canvasName, "w1", watch, EMPTY_SNAPSHOTS, glyphIndexOf("proj", rows));
    expect(result.state).toEqual({ status: "pending", detail: "2/3 done" });
  });

  it("is satisfied only when every scoped glyph is done — abandoned counts as not-done", () => {
    const allDone = [glyphRow({ glyphId: "g1", state: "done" }), glyphRow({ glyphId: "g2", state: "done" })];
    expect(evaluateWatcher(canvasName, "w1", watch, EMPTY_SNAPSHOTS, glyphIndexOf("proj", allDone)).state).toEqual({
      status: "satisfied",
      detail: "2/2 done",
    });

    const withAbandoned = [
      glyphRow({ glyphId: "g1", state: "done" }),
      glyphRow({ glyphId: "g2", state: "abandoned" }),
    ];
    const abandonedResult = evaluateWatcher(canvasName, "w2", watch, EMPTY_SNAPSHOTS, glyphIndexOf("proj", withAbandoned));
    expect(abandonedResult.state.status).toBe("pending");
    expect(abandonedResult.state.detail).toBe("1/2 done (1 abandoned)");
  });
});

// --- stat_threshold --------------------------------------------------------------

describe("evaluateWatcher — stat_threshold", () => {
  const watch: EtherWatch = { kind: "stat_threshold", source: "tower", key: "proj", stat: "signals", op: "gt", value: 10 };
  const canvasName = "test-canvas";

  it("is unknown when the bound entity is missing", () => {
    const result = evaluateWatcher(canvasName, "w1", watch, EMPTY_SNAPSHOTS, new Map());
    expect(result.state.status).toBe("unknown");
  });

  it("is satisfied when the stat crosses the threshold, with a readable detail", () => {
    const result = evaluateWatcher(canvasName, "w1", watch, snapshotsWithStat("signals", 34), new Map());
    expect(result.state).toEqual({ status: "satisfied", detail: "signals 34 > 10" });
  });

  it("is pending when the stat hasn't crossed the threshold", () => {
    const result = evaluateWatcher(canvasName, "w1", watch, snapshotsWithStat("signals", 3), new Map());
    expect(result.state).toEqual({ status: "pending", detail: "signals 3 > 10" });
  });
});

// --- glyphs_entered_state (edge rule) ---------------------------------------------

describe("evaluateWatcher — glyphs_entered_state (edge rule)", () => {
  const watch: EtherWatch = { kind: "glyphs_entered_state", project: "proj", state: "committed" };
  const canvasName = "test-canvas";

  it("never fires on the first observation of a glyph — baseline only", () => {
    const rows = [glyphRow({ glyphId: "g1", state: "committed" })];
    const result = evaluateWatcher(canvasName, "w1", watch, EMPTY_SNAPSHOTS, glyphIndexOf("proj", rows));
    expect(result.fired).toBe(false);
    expect(result.firedGlyphIds).toEqual([]);
  });

  it("fires when a scoped glyph transitions into the target state on a later pass", () => {
    evaluateWatcher(canvasName, "w1", watch, EMPTY_SNAPSHOTS, glyphIndexOf("proj", [glyphRow({ glyphId: "g1", state: "exploring" })])); // baseline
    const result = evaluateWatcher(
      canvasName,
      "w1",
      watch,
      EMPTY_SNAPSHOTS,
      glyphIndexOf("proj", [glyphRow({ glyphId: "g1", state: "committed" })]),
    );
    expect(result.fired).toBe(true);
    expect(result.firedGlyphIds).toEqual(["g1"]);
    expect(result.state.status).toBe("satisfied");
  });

  it("does not re-fire on the next pass once the glyph stays in the target state", () => {
    evaluateWatcher(canvasName, "w1", watch, EMPTY_SNAPSHOTS, glyphIndexOf("proj", [glyphRow({ glyphId: "g1", state: "exploring" })])); // baseline
    evaluateWatcher(canvasName, "w1", watch, EMPTY_SNAPSHOTS, glyphIndexOf("proj", [glyphRow({ glyphId: "g1", state: "committed" })])); // fires
    const stillCommitted = evaluateWatcher(
      canvasName,
      "w1",
      watch,
      EMPTY_SNAPSHOTS,
      glyphIndexOf("proj", [glyphRow({ glyphId: "g1", state: "committed" })]),
    );
    expect(stillCommitted.fired).toBe(false);
  });

  it("keys edge memory per watcher node, so two watchers on the same glyph don't interfere", () => {
    const baseline = glyphIndexOf("proj", [glyphRow({ glyphId: "g1", state: "exploring" })]);
    evaluateWatcher(canvasName, "watcher-a", watch, EMPTY_SNAPSHOTS, baseline);
    evaluateWatcher(canvasName, "watcher-b", watch, EMPTY_SNAPSHOTS, baseline);

    const entered = glyphIndexOf("proj", [glyphRow({ glyphId: "g1", state: "committed" })]);
    const resultA = evaluateWatcher(canvasName, "watcher-a", watch, EMPTY_SNAPSHOTS, entered);
    const resultB = evaluateWatcher(canvasName, "watcher-b", watch, EMPTY_SNAPSHOTS, entered);
    expect(resultA.fired).toBe(true);
    expect(resultB.fired).toBe(true);
  });
});

// --- level-rule rising-edge (drives whether a watcher pulses a region) -----------

describe("evaluateWatcher — level rules only fire on a rising edge into satisfied", () => {
  const canvasName = "test-canvas";

  it("never fires on a watcher's first evaluation, even if already satisfied", () => {
    const watch: EtherWatch = { kind: "glyphs_done", project: "proj" };
    const done = glyphIndexOf("proj", [glyphRow({ glyphId: "g1", state: "done" })]);
    const result = evaluateWatcher(canvasName, "w1", watch, EMPTY_SNAPSHOTS, done);
    expect(result.state.status).toBe("satisfied");
    expect(result.fired).toBe(false);
  });

  it("fires when status transitions from pending to satisfied on a later pass", () => {
    const watch: EtherWatch = { kind: "glyphs_done", project: "proj" };
    evaluateWatcher(canvasName, "w1", watch, EMPTY_SNAPSHOTS, glyphIndexOf("proj", [glyphRow({ glyphId: "g1", state: "building" })]));
    const result = evaluateWatcher(canvasName, "w1", watch, EMPTY_SNAPSHOTS, glyphIndexOf("proj", [glyphRow({ glyphId: "g1", state: "done" })]));
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
          ether: { entity: { kind: "watcher" }, watch: { kind: "glyphs_done", project: "proj" } },
        },
        { id: "plain-note", type: "text", text: "just a note", x: 200, y: 0, width: 100, height: 40 },
      ],
      edges: [],
    };
    const glyphIndex = glyphIndexOf("proj", [glyphRow({ glyphId: "g1", state: "done" })]);
    const results = detectPulses(canvasName, doc, EMPTY_SNAPSHOTS, glyphIndex);
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

// --- deliverPulse: arming, hard cap, regionless — no chat calls -------------------

describe("deliverPulse — arming and the hard cap", () => {
  const regionId = "region-cap-test";
  const canvasName = "test-canvas";

  beforeEach(() => {
    __resetPulseLogForTest();
    __setDocsForTest(new Map([[canvasName, { nodes: [], edges: [] }]]));
    // Set default deps that simulate successful delivery when arming is true
    const defaultDeps: PulseDeliverDeps = {
      isLive: () => true,
      openChat: async () => undefined,
      sendPrompt: async () => undefined,
    };
    __setDeliveryDepsForTest(defaultDeps);
  });

  afterEach(() => {
    __setDeliveryDepsForTest(undefined);
  });

  it("stays live (non-dry) for the first PULSE_CAP_PER_REGION_PER_HOUR deliveries", async () => {
    __resetPulseLogForTest();
    setArmed(`${canvasName}::${regionId}`, true);
    for (let i = 0; i < PULSE_CAP_PER_REGION_PER_HOUR; i += 1) {
      await deliverPulse({ canvasName, sourceNodeId: `n${i}`, kind: "manual", regionId, summary: `pulse ${i}` });
    }
    const log = getPulseLog();
    expect(log).toHaveLength(PULSE_CAP_PER_REGION_PER_HOUR);
    expect(log.every((record) => record.dry === false)).toBe(true);
  });

  it("forces delivery past the cap to dry, with a cap note on the summary", async () => {
    __resetPulseLogForTest();
    setArmed(`${canvasName}::${regionId}`, true);
    for (let i = 0; i < PULSE_CAP_PER_REGION_PER_HOUR; i += 1) {
      await deliverPulse({ canvasName, sourceNodeId: `n${i}`, kind: "manual", regionId, summary: `pulse ${i}` });
    }
    await deliverPulse({ canvasName, sourceNodeId: "n-over", kind: "manual", regionId, summary: "one too many" });

    const log = getPulseLog();
    expect(log).toHaveLength(PULSE_CAP_PER_REGION_PER_HOUR + 1);
    const last = log[log.length - 1];
    expect(last?.dry).toBe(true);
    expect(last?.summary).toContain("cap reached");
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
        ether: { bindings: [{ source: "hermes", ref: { type: "agent", key: "remote-a:vega" } }] },
      },
      {
        id: "agent-b",
        type: "text",
        text: "agent b",
        x: 200,
        y: 200,
        width: 100,
        height: 50,
        ether: { bindings: [{ source: "hermes", ref: { type: "agent", key: "remote-a:nova" } }] },
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
        ether: { bindings: [{ source: "hermes", ref: { type: "agent", key: "remote-a:outside" } }] },
      },
    ],
    edges: [],
  };

  beforeEach(() => {
    __resetPulseLogForTest();
    __setDocsForTest(new Map([[canvasName, agentDoc]]));
    setArmed(`${canvasName}::${regionId}`, true);
  });

  afterEach(() => {
    __setDeliveryDepsForTest(undefined);
  });

  it("opens only the not-yet-live agent, then sends every member sequentially in order", async () => {
    const calls: string[] = [];
    const deps: PulseDeliverDeps = {
      isLive: (key) => key === "remote-a:nova",
      openChat: async (key) => {
        calls.push(`open:${key}`);
      },
      sendPrompt: async (key, message) => {
        calls.push(`send:${key}:${message}`);
      },
    };

    await deliverPulse({ canvasName, sourceNodeId: regionId, kind: "manual", regionId, summary: "go", deps });

    expect(calls).toEqual([
      "open:remote-a:vega",
      "send:remote-a:vega:[pulse] go",
      "send:remote-a:nova:[pulse] go",
    ]);
    const record = getPulseLog()[0];
    expect(record?.dry).toBe(false);
    expect(record?.delivered).toEqual(["remote-a:vega", "remote-a:nova"]);
  });

  it("one agent's delivery failure doesn't sink the rest", async () => {
    const deps: PulseDeliverDeps = {
      isLive: () => true,
      openChat: async () => undefined,
      sendPrompt: async (key) => {
        if (key === "remote-a:vega") throw new Error("boom");
      },
    };
    await deliverPulse({ canvasName, sourceNodeId: regionId, kind: "manual", regionId, summary: "go", deps });
    const record = getPulseLog()[0];
    expect(record?.delivered).toEqual(["remote-a:nova"]);
  });
});
