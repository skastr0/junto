import { describe, expect, it } from "vitest";
import type { EtherView } from "../src/shared/canvas";
import type { Entity, SnapshotState } from "../src/shared/entities";
import { entityReadout } from "../src/renderer/lib/entity-readout";

// Connections are derived from identity: one project entity named "prism"
// stands in for what used to be two stored bindings.
const prism = { kind: "project", name: "prism" } as const;

const towerEntity = (statsOverride: Entity["stats"] = {}): Entity => ({
  source: "tower",
  key: "prism",
  kind: "project",
  title: "Prism",
  stats: {
    glyphs_active: 82,
    glyphs_done: 213,
    signals: 4,
    orbit_forge: 12,
    orbit_beacon: 3,
    ...statsOverride,
  },
  updatedAt: "2026-01-01T00:00:00Z",
});

const quasarEntity: Entity = {
  source: "quasar",
  key: "git:github.com/skastr0/prism",
  kind: "project",
  title: "prism",
  stats: { sessions: 512 },
  updatedAt: "2026-01-01T00:00:00Z",
};

const snapshots = (tower: Entity = towerEntity()): SnapshotState => ({
  bundles: [
    { source: "tower", fetchedAt: "2026-01-01T00:00:00Z", ok: true, entities: [tower] },
    { source: "quasar", fetchedAt: "2026-01-01T00:00:00Z", ok: true, entities: [quasarEntity] },
  ],
});

describe("entityReadout", () => {
  it("reads the global active count when there is no view", () => {
    const { segments } = entityReadout(prism, snapshots());
    expect(segments).toContain("82 active");
    expect(segments.some((s) => s.includes(" in "))).toBe(false);
  });

  it("scopes the active count to the view's orbit instead of the global count", () => {
    const view: EtherView = { orbit: "forge" };
    const { segments } = entityReadout(prism, snapshots(), view);
    expect(segments[0]).toBe("12 active in forge");
    expect(segments).not.toContain("82 active");
  });

  it("reports zero for an orbit with no active glyphs, rather than omitting the segment", () => {
    const view: EtherView = { orbit: "oracle" };
    const { segments } = entityReadout(prism, snapshots(), view);
    expect(segments[0]).toBe("0 active in oracle");
  });

  it("keeps the done/signals tower segments and other-source segments untouched by an orbit view", () => {
    const view: EtherView = { orbit: "forge" };
    const { segments } = entityReadout(prism, snapshots(), view);
    expect(segments).toContain("213 done");
    expect(segments).toContain("4 signals");
    expect(segments).toContain("512 sessions");
  });

  it("appends a truncated filter glyph segment when glyphQuery is set", () => {
    const view: EtherView = { glyphQuery: "a".repeat(25) };
    const { segments } = entityReadout(prism, snapshots(), view);
    expect(segments.at(-1)).toBe(`⌕ ${"a".repeat(18)}…`);
  });

  it("does not truncate a short glyphQuery", () => {
    const view: EtherView = { glyphQuery: "bug" };
    const { segments } = entityReadout(prism, snapshots(), view);
    expect(segments.at(-1)).toBe("⌕ bug");
  });

  it("caps total segments at 4, always keeping the filter glyph segment last", () => {
    const view: EtherView = { glyphQuery: "bug" };
    const { segments } = entityReadout(prism, snapshots(), view);
    expect(segments.length).toBeLessThanOrEqual(4);
    expect(segments.at(-1)).toBe("⌕ bug");
  });

  it("omits the filter glyph segment entirely when no glyphQuery is set", () => {
    const view: EtherView = { orbit: "forge" };
    const { segments } = entityReadout(prism, snapshots(), view);
    expect(segments.some((s) => s.startsWith("⌕"))).toBe(false);
  });

  it("still reports one connector dot per resolved source regardless of view", () => {
    const view: EtherView = { orbit: "forge", glyphQuery: "bug" };
    const { dots } = entityReadout(prism, snapshots(), view);
    expect(dots).toEqual([
      { source: "tower", ok: true },
      { source: "quasar", ok: true },
    ]);
  });
});
