import { describe, expect, it } from "vitest";
import type { SnapshotState } from "../src/shared/entities";
import {
  boothKeyForTower,
  boothPendingReview,
  effectiveBindings,
  entityReadout,
} from "../src/renderer/lib/entity-readout";
import { orderDrafts } from "../src/renderer/lib/booth-browse";

const snapshots = (stats: Record<string, number | string>, boothKey = "vellum"): SnapshotState => ({
  bundles: [
    {
      source: "booth",
      fetchedAt: "2026-07-15T00:00:00.000Z",
      ok: true,
      entities: [
        { source: "booth", key: boothKey, kind: "project", stats, updatedAt: "2026-07-15T00:00:00.000Z" },
      ],
    },
  ],
});

const boothBinding = [{ source: "booth" as const, ref: { type: "project" as const, key: "vellum" } }];
const towerBinding = [{ source: "tower" as const, ref: { type: "project" as const, key: "vellum" } }];

describe("booth card segments", () => {
  it("reads 'N drafts · K to review' when a verdict is owed", () => {
    const { segments } = entityReadout(boothBinding, snapshots({ drafts: 3, pending_review: 2, needs_revision: 0 }));
    expect(segments).toEqual(["3 drafts", "2 to review"]);
  });

  it("falls back to the revising count when nothing is pending on the human", () => {
    const { segments } = entityReadout(boothBinding, snapshots({ drafts: 3, pending_review: 0, needs_revision: 2 }));
    expect(segments).toEqual(["3 drafts", "2 revising"]);
  });

  it("an all-zero project shows nothing (never a wall of zeros)", () => {
    const { segments } = entityReadout(boothBinding, snapshots({ drafts: 0, pending_review: 0, needs_revision: 0 }));
    expect(segments).toEqual([]);
  });
});

describe("implicit booth resolution", () => {
  it("a tower-bound node joins its booth project by key equality — no booth binding stored", () => {
    const state = snapshots({ drafts: 2, pending_review: 2 });
    expect(boothKeyForTower("vellum", state)).toBe("vellum");
    expect(effectiveBindings(towerBinding, state)).toEqual([
      ...towerBinding,
      { source: "booth", ref: { type: "project", key: "vellum" } },
    ]);
    // decal + readout light up exactly as if the binding were stored
    expect(boothPendingReview(towerBinding, state)).toBe(2);
    const { segments, dots } = entityReadout(towerBinding, state);
    expect(segments).toContain("2 to review");
    expect(dots.map((dot) => dot.source)).toEqual(["tower", "booth"]);
  });

  it("joins through booth's tower_project linkage when the keys differ", () => {
    const state = snapshots({ tower_project: "vellum", drafts: 1, pending_review: 1 }, "vellum-assets");
    expect(boothKeyForTower("vellum", state)).toBe("vellum-assets");
    expect(boothPendingReview(towerBinding, state)).toBe(1);
  });

  it("an explicit booth binding wins — nothing is synthesized on top", () => {
    const state = snapshots({ drafts: 1, pending_review: 1 });
    const stored = [...towerBinding, ...boothBinding];
    expect(effectiveBindings(stored, state)).toEqual(stored);
  });

  it("no tower binding, or no matching booth project → nothing implicit", () => {
    expect(effectiveBindings([], snapshots({ drafts: 1 }))).toEqual([]);
    expect(boothKeyForTower("prism", snapshots({ drafts: 1 }))).toBeUndefined();
  });
});

describe("boothPendingReview (the decal input)", () => {
  it("totals pending_review across booth bindings only", () => {
    expect(boothPendingReview(boothBinding, snapshots({ drafts: 3, pending_review: 2 }))).toBe(2);
  });

  it("is 0 with no booth connection or no stat", () => {
    expect(boothPendingReview([], snapshots({ pending_review: 5 }))).toBe(0);
    expect(boothPendingReview(boothBinding, snapshots({ drafts: 1 }))).toBe(0);
  });
});

describe("orderDrafts", () => {
  it("floats attention states above settled ones, newest first within a status", () => {
    const rows = [
      { id: "a", status: "approved", updatedAt: "2026-07-15T03:00:00Z" },
      { id: "b", status: "ready_for_review", updatedAt: "2026-07-15T01:00:00Z" },
      { id: "c", status: "ready_for_review", updatedAt: "2026-07-15T02:00:00Z" },
      { id: "d", status: "superseded", updatedAt: "2026-07-15T09:00:00Z" },
      { id: "e", status: "needs_revision", updatedAt: "2026-07-15T00:00:00Z" },
    ];
    expect(orderDrafts(rows).map((row) => row.id)).toEqual(["c", "b", "e", "a", "d"]);
  });

  it("unknown statuses sink to the bottom rather than crashing the sort", () => {
    const rows = [
      { id: "x", status: "someday_new_status", updatedAt: "2026-07-15T05:00:00Z" },
      { id: "y", status: "ready_for_review", updatedAt: "2026-07-15T01:00:00Z" },
    ];
    expect(orderDrafts(rows).map((row) => row.id)).toEqual(["y", "x"]);
  });
});
