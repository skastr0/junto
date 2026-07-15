import { describe, expect, it } from "vitest";
import type { SnapshotState } from "../src/shared/entities";
import { boothPendingReview, entityReadout } from "../src/renderer/lib/entity-readout";
import { orderDrafts } from "../src/renderer/lib/booth-browse";

const snapshots = (stats: Record<string, number>): SnapshotState => ({
  bundles: [
    {
      source: "booth",
      fetchedAt: "2026-07-15T00:00:00.000Z",
      ok: true,
      entities: [
        { source: "booth", key: "vellum", kind: "project", stats, updatedAt: "2026-07-15T00:00:00.000Z" },
      ],
    },
  ],
});

const boothBinding = [{ source: "booth" as const, ref: { type: "project" as const, key: "vellum" } }];

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

describe("boothPendingReview (the decal input)", () => {
  it("totals pending_review across booth bindings only", () => {
    expect(boothPendingReview(boothBinding, snapshots({ drafts: 3, pending_review: 2 }))).toBe(2);
  });

  it("is 0 with no booth binding or no stat", () => {
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
