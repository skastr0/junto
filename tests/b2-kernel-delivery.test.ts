import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { resetWatcherMemory } from "../src/main/vellum/kernel/evaluate";
import {
  __resetDeliveryQueueForTest,
  __setDeliveryDepsForTest,
  __setSnapshotsForTest,
  __setDocsForTest,
  __setStationScopeForTest,
  deliverPulse,
  MIN_LIVE_PULSE_SPACING_MS,
  runEvaluationCycle,
  type PulseDeliverDeps,
  setArmed,
  getPulseLog,
} from "../src/main/vellum/kernel/cycle";

const snapshotsWithStat = (stat: string, value: number): SnapshotState => ({
  bundles: [
    {
      source: "hermes",
      fetchedAt: new Date().toISOString(),
      ok: true,
      entities: [
        { source: "hermes", key: "proj", kind: "project", stats: { [stat]: value }, updatedAt: new Date().toISOString() },
      ],
    },
  ],
});

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | "TIMEOUT"> =>
  Promise.race([p, new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), ms))]);

// --- BUG 3: a hung agent turn must not freeze the evaluation cycle ------------

describe("runEvaluationCycle — one hung delivery does not stall watcher/timer evaluation", () => {
  const regionId = "region-hang";
  const canvasName = "test-canvas";
  // A stat_threshold watcher (no glyph fetch) + a hermes agent, both inside an
  // armed region — so a fire produces a real, live delivery.
  const doc: CanvasDoc = {
    nodes: [
      { id: regionId, type: "group", x: 0, y: 0, width: 400, height: 400 },
      {
        id: "watcher-1",
        type: "text",
        text: "watch",
        x: 40,
        y: 40,
        width: 120,
        height: 40,
        ether: {
          entity: { kind: "watcher" },
          watch: { kind: "stat_threshold", source: "hermes", key: "proj", stat: "signals", op: "gt", value: 10 },
        },
      },
      {
        id: "agent-a",
        type: "text",
        text: "agent",
        x: 60,
        y: 140,
        width: 100,
        height: 50,
        // local host so command-center station scope (default) may fire + deliver
        ether: { entity: { kind: "agent", name: "local:vega" } },
      },
    ],
    // Host-scoped fire routes on edges, not region membership alone.
    edges: [{ id: "e-watch-agent", fromNode: "watcher-1", toNode: "agent-a" }],
  };

  beforeEach(() => {
    resetWatcherMemory();
    __resetDeliveryQueueForTest();
    // Fail-closed default is role "unset" (no fire). Tests need CC scope.
    __setStationScopeForTest({ hostId: "local", role: "command-center" });
    __setDocsForTest(new Map([[canvasName, doc]]));
    setArmed(`${canvasName}::${regionId}`, true);
  });

  afterEach(() => {
    __resetDeliveryQueueForTest();
  });

  it("completes the cycle promptly even when the fired pulse's sendPrompt never resolves", async () => {
    // pass 1: signals below threshold -> pending baseline, no fire.
    __setSnapshotsForTest(snapshotsWithStat("signals", 3));
    await runEvaluationCycle();

    // Deliver through an agent whose turn hangs forever (models a tool-heavy /
    // ssh-stalled chat turn bounded only by the 15-minute IPC ceiling).
    let sendStarted = false;
    const hangingDeps: PulseDeliverDeps = {
      isLive: () => true,
      openChat: async () => undefined,
      sendPrompt: () => {
        sendStarted = true;
        return new Promise<void>(() => {}); // never resolves
      },
    };
    __setDeliveryDepsForTest(hangingDeps);

    // pass 2: signals cross the threshold -> rising edge -> fires -> enqueues a
    // delivery that will hang. If delivery were still awaited inline, this cycle
    // would not resolve until the (15-min) turn returned.
    __setSnapshotsForTest(snapshotsWithStat("signals", 34));
    const outcome = await withTimeout(runEvaluationCycle(), 1000);

    expect(outcome).not.toBe("TIMEOUT"); // the evaluation loop completed on schedule
    expect(sendStarted).toBe(true); // a live delivery genuinely started off-cycle (not skipped/dry)
    // Delivery is still pending (the record only lands once sendPrompt resolves,
    // which it never does) — proving evaluation is decoupled from delivery.
    expect(getPulseLog()).toHaveLength(0);
  });
});

// --- the spacing window must hold at arbitrary log volume ---------------------

describe("deliverPulse — live-pulse spacing holds past 200 mixed-region records", () => {
  const armedRegion = "region-A";
  const canvasName = "test-canvas";

  beforeEach(() => {
    __resetDeliveryQueueForTest();
    __setDocsForTest(new Map([[canvasName, { nodes: [], edges: [] }]]));
    setArmed(`${canvasName}::${armedRegion}`, true);
  });

  afterEach(() => {
    __resetDeliveryQueueForTest();
  });

  it("does not let a busy canvas evict the region's last live record and fail the spacing open", async () => {
    // One live delivery starts region A's spacing window.
    await deliverPulse({ canvasName, sourceNodeId: "a0", kind: "watcher", regionId: armedRegion, summary: "a 0" });

    // Flood the shared log with >200 records from OTHER, disarmed regions (all
    // dry). A size-only ring buffer (last 200 by count) would evict region A's
    // live record — dropping the timestamp the cooldown check needs while it is
    // still inside its spacing window — so the spacing would fail open.
    for (let i = 0; i < 300; i += 1) {
      await deliverPulse({
        canvasName,
        sourceNodeId: `b${i}`,
        kind: "timer",
        regionId: `region-other-${i % 5}`,
        summary: `b ${i}`,
      });
    }

    // region A asks again, still inside the same spacing window.
    await deliverPulse({ canvasName, sourceNodeId: "a-second", kind: "watcher", regionId: armedRegion, summary: "second" });

    const log = getPulseLog();
    expect(log.length).toBeGreaterThan(200); // past the old eviction point — proves the flood took effect

    // Region A's live record survived the flood (age-retained), so the spacing
    // check saw it and suppressed the second ask.
    const aLive = log.filter((record) => record.regionId === armedRegion && !record.dry);
    expect(aLive).toHaveLength(1);

    const aRecords = log.filter((record) => record.regionId === armedRegion);
    const second = aRecords[aRecords.length - 1];
    expect(second?.dry).toBe(true);
    expect(second?.summary).toContain("cooldown");
  });
});
