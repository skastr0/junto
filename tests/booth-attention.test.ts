import { describe, expect, it } from "vitest";
import type { SnapshotState } from "../src/shared/entities";
import { computeBoothAttention, startBoothAttention, type BoothAttentionAlert } from "../src/main/vellum/booth-attention";

const stateWith = (
  ok: boolean,
  projects: ReadonlyArray<{ readonly key: string; readonly pending?: number }>,
): SnapshotState => ({
  bundles: [
    {
      source: "booth",
      fetchedAt: "2026-07-15T00:00:00.000Z",
      ok,
      ...(ok ? {} : { error: "booth unreachable" }),
      entities: projects.map(({ key, pending }) => ({
        source: "booth" as const,
        key,
        kind: "project",
        stats: (pending === undefined ? {} : { pending_review: pending }) as Record<string, number>,
        updatedAt: "2026-07-15T00:00:00.000Z",
      })),
    },
  ],
});

describe("computeBoothAttention", () => {
  it("first OK bundle is a silent baseline — counts, no alerts", () => {
    const result = computeBoothAttention(undefined, stateWith(true, [{ key: "vellum", pending: 2 }]));
    expect(result.alerts).toEqual([]);
    expect(result.counts.get("vellum")).toBe(2);
  });

  it("alerts only on a RISING pending count, with the delta", () => {
    const baseline = new Map([["vellum", 2]]);
    const result = computeBoothAttention(baseline, stateWith(true, [{ key: "vellum", pending: 5 }]));
    expect(result.alerts).toEqual([{ projectKey: "vellum", pending: 5, delta: 3 }]);
  });

  it("stays silent on falling or steady counts", () => {
    const baseline = new Map([["vellum", 3]]);
    expect(computeBoothAttention(baseline, stateWith(true, [{ key: "vellum", pending: 3 }])).alerts).toEqual([]);
    expect(computeBoothAttention(baseline, stateWith(true, [{ key: "vellum", pending: 1 }])).alerts).toEqual([]);
  });

  it("a project appearing after baseline rises from 0", () => {
    const baseline = new Map([["vellum", 1]]);
    const result = computeBoothAttention(baseline, stateWith(true, [
      { key: "vellum", pending: 1 },
      { key: "flare", pending: 2 },
    ]));
    expect(result.alerts).toEqual([{ projectKey: "flare", pending: 2, delta: 2 }]);
  });

  it("an outage keeps previous counts so recovery does not re-announce", () => {
    const baseline = new Map([["vellum", 4]]);
    const outage = computeBoothAttention(baseline, stateWith(false, []));
    expect(outage.alerts).toEqual([]);
    expect(outage.counts).toBe(baseline);
    // recovery at the same count: still silent
    const recovered = computeBoothAttention(outage.counts, stateWith(true, [{ key: "vellum", pending: 4 }]));
    expect(recovered.alerts).toEqual([]);
  });
});

describe("startBoothAttention", () => {
  it("baselines on first OK bundle even after leading outages, then alerts on the rise", () => {
    let listener: ((state: SnapshotState) => void) | undefined;
    const alerts: BoothAttentionAlert[] = [];
    startBoothAttention(
      (fn) => {
        listener = fn;
        return () => undefined;
      },
      (alert) => alerts.push(alert),
    );

    // outage before any baseline: must NOT count as a baseline
    listener?.(stateWith(false, []));
    // first OK bundle: silent baseline despite 3 already waiting
    listener?.(stateWith(true, [{ key: "vellum", pending: 3 }]));
    expect(alerts).toEqual([]);
    // the rise fires exactly once, with the delta
    listener?.(stateWith(true, [{ key: "vellum", pending: 4 }]));
    expect(alerts).toEqual([{ projectKey: "vellum", pending: 4, delta: 1 }]);
    // steady poll after: silent
    listener?.(stateWith(true, [{ key: "vellum", pending: 4 }]));
    expect(alerts).toHaveLength(1);
  });
});
