import { afterEach, describe, expect, it } from "vitest";
import type { EtherWatch } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import { evaluateWatcher, resetWatcherMemory } from "../src/main/junto/kernel/evaluate";

// --- fixtures ----------------------------------------------------------------

const EMPTY_SNAPSHOTS: SnapshotState = { bundles: [] };

const snapshotsWithStat = (value: number): SnapshotState => ({
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
          stats: { signals: value },
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  ],
});

// An empty / missing entity means the source is down/absent — evaluation
// degrades to "unknown" (same state a slow hermes poll produces).
const SOURCE_DOWN = EMPTY_SNAPSHOTS;

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

// --- BUG 1: unknown -> satisfied must not be a rising edge --------------------

describe("level watcher — recovery from an unknown source blip does not re-fire", () => {
  const satisfied = snapshotsWithStat(34);
  const pending = snapshotsWithStat(3);
  const canvasName = "test-canvas";

  it("a satisfied -> unknown -> satisfied blip never manufactures a fresh fire", () => {
    // pass 1: already satisfied on first look -> baseline, never fires
    const baseline = evaluateWatcher(canvasName, "w1", STAT_WATCH, satisfied);
    expect(baseline.state.status).toBe("satisfied");
    expect(baseline.fired).toBe(false);

    // pass 2: the source is briefly down -> unknown; must not fire, and must
    // not overwrite the "satisfied" baseline the recovery is compared against
    const blip = evaluateWatcher(canvasName, "w1", STAT_WATCH, SOURCE_DOWN);
    expect(blip.state.status).toBe("unknown");
    expect(blip.fired).toBe(false);

    // pass 3: source recovers, condition is still (unchanged) satisfied. The
    // bug fired here because `previous` had been clobbered to "unknown".
    const recovered = evaluateWatcher(canvasName, "w1", STAT_WATCH, satisfied);
    expect(recovered.state.status).toBe("satisfied");
    expect(recovered.fired).toBe(false);
  });

  it("a genuine pending -> satisfied edge still fires even across an unknown blip", () => {
    evaluateWatcher(canvasName, "w1", STAT_WATCH, pending); // baseline: pending
    const blip = evaluateWatcher(canvasName, "w1", STAT_WATCH, SOURCE_DOWN); // source down
    expect(blip.fired).toBe(false);
    // The awaited transition genuinely happened while (or after) the source was
    // down; the pending baseline survives the blip, so the edge still fires.
    const crossed = evaluateWatcher(canvasName, "w1", STAT_WATCH, satisfied);
    expect(crossed.state.status).toBe("satisfied");
    expect(crossed.fired).toBe(true);
  });

  it("an unknown first observation is not a baseline, so the first real read cannot fire", () => {
    const first = evaluateWatcher(canvasName, "w1", STAT_WATCH, SOURCE_DOWN);
    expect(first.state.status).toBe("unknown");
    expect(first.fired).toBe(false);
    // First KNOWN observation is the baseline — satisfied here must not fire.
    const second = evaluateWatcher(canvasName, "w1", STAT_WATCH, satisfied);
    expect(second.state.status).toBe("satisfied");
    expect(second.fired).toBe(false);
  });
});
