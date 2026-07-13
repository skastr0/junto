import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { resetWatcherMemory } from "../src/renderer/lib/kernel";
import {
  __resetDeliveryQueueForTest,
  __setDeliveryDepsForTest,
  deliverPulse,
  kernel$,
  PULSE_CAP_PER_REGION_PER_HOUR,
  runEvaluationCycle,
  type PulseDeliverDeps,
} from "../src/renderer/lib/kernel-state";
import { state$ } from "../src/renderer/lib/state";

const snapshotsWithStat = (stat: string, value: number): SnapshotState => ({
  bundles: [
    {
      source: "tower",
      fetchedAt: new Date().toISOString(),
      ok: true,
      entities: [
        { source: "tower", key: "proj", kind: "project", stats: { [stat]: value }, updatedAt: new Date().toISOString() },
      ],
    },
  ],
});

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | "TIMEOUT"> =>
  Promise.race([p, new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), ms))]);

// --- BUG 3: a hung agent turn must not freeze the evaluation cycle ------------

describe("runEvaluationCycle — one hung delivery does not stall watcher/timer evaluation", () => {
  const regionId = "region-hang";
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
        ether: { watch: { kind: "stat_threshold", source: "tower", key: "proj", stat: "signals", op: "gt", value: 10 } },
      },
      {
        id: "agent-a",
        type: "text",
        text: "agent",
        x: 60,
        y: 140,
        width: 100,
        height: 50,
        ether: { bindings: [{ source: "hermes", ref: { type: "agent", key: "remote-a:vega" } }] },
      },
    ],
    edges: [],
  };

  beforeEach(() => {
    resetWatcherMemory();
    __resetDeliveryQueueForTest();
    kernel$.armed.set({});
    kernel$.watchers.set({});
    kernel$.pulseLog.set([]);
    state$.doc.set(doc);
    kernel$.armed[regionId].set(true);
  });

  afterEach(() => {
    __resetDeliveryQueueForTest();
  });

  it("completes the cycle promptly even when the fired pulse's sendPrompt never resolves", async () => {
    // pass 1: signals below threshold -> pending baseline, no fire.
    state$.snapshots.set(snapshotsWithStat("signals", 3));
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
    state$.snapshots.set(snapshotsWithStat("signals", 34));
    const outcome = await withTimeout(runEvaluationCycle(), 1000);

    expect(outcome).not.toBe("TIMEOUT"); // the evaluation loop completed on schedule
    expect(sendStarted).toBe(true); // a live delivery genuinely started off-cycle (not skipped/dry)
    // Delivery is still pending (the record only lands once sendPrompt resolves,
    // which it never does) — proving evaluation is decoupled from delivery.
    expect(kernel$.pulseLog.peek()).toHaveLength(0);
  });
});

// --- BUG 4: the hourly cap must hold at arbitrary log volume ------------------

describe("deliverPulse — the per-region hourly cap holds past 200 mixed-region records", () => {
  const armedRegion = "region-A";

  beforeEach(() => {
    __resetDeliveryQueueForTest();
    kernel$.armed.set({});
    kernel$.pulseLog.set([]);
    state$.doc.set({ nodes: [], edges: [] });
    kernel$.armed[armedRegion].set(true);
  });

  afterEach(() => {
    __resetDeliveryQueueForTest();
  });

  it("does not let a busy canvas evict an armed region's within-hour deliveries and fail the cap open", async () => {
    // Spend region A's whole hourly budget: 6 live deliveries.
    for (let i = 0; i < PULSE_CAP_PER_REGION_PER_HOUR; i += 1) {
      await deliverPulse({ sourceNodeId: `a${i}`, kind: "watcher", regionId: armedRegion, summary: `a ${i}` });
    }

    // Flood the shared log with >200 records from OTHER, disarmed regions (all
    // dry). The old size-only ring buffer (last 200 by count) would evict
    // region A's 6 live records here — dropping them from the cap count while
    // they are still inside their rolling hour — so the cap would fail open.
    for (let i = 0; i < 300; i += 1) {
      await deliverPulse({ sourceNodeId: `b${i}`, kind: "timer", regionId: `region-other-${i % 5}`, summary: `b ${i}` });
    }

    // region A asks for a 7th live delivery, still inside the same hour.
    await deliverPulse({ sourceNodeId: "a-seventh", kind: "watcher", regionId: armedRegion, summary: "seventh" });

    const log = kernel$.pulseLog.peek();
    expect(log.length).toBeGreaterThan(200); // past the old eviction point — proves the flood took effect

    // All 6 of region A's live records survived the flood (age-retained), so the
    // cap counted them correctly.
    const aLive = log.filter((record) => record.regionId === armedRegion && !record.dry);
    expect(aLive).toHaveLength(PULSE_CAP_PER_REGION_PER_HOUR);

    // The 7th was correctly capped to a dry pulse — the cap held.
    const aRecords = log.filter((record) => record.regionId === armedRegion);
    const seventh = aRecords[aRecords.length - 1];
    expect(seventh?.dry).toBe(true);
    expect(seventh?.summary).toContain("cap reached");
  });
});
