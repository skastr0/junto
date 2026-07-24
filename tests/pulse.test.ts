import { describe, expect, it } from "vitest";
import { comparePulse, type PulseItem } from "../src/renderer/lib/pulse";
import type { SnapshotState } from "../src/shared/entities";

describe("pulse.ts", () => {
  describe("comparePulse", () => {
    it("returns empty array when prev is null (first-ever snapshot)", () => {
      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "proj-1",
                kind: "project",
                title: "Project 1",
                stats: { glyphs_active: 5 },
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(null, next);
      expect(items).toEqual([]);
    });

    it("returns empty array when no changes between snapshots", () => {
      const shared: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "proj-1",
                kind: "project",
                title: "Project 1",
                stats: { glyphs_active: 5, signals: 2 },
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(shared, shared);
      expect(items).toEqual([]);
    });

    it("detects glyphs_active increase", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "proj-1",
                kind: "project",
                title: "My Project",
                stats: { glyphs_active: 3 },
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "proj-1",
                kind: "project",
                title: "My Project",
                stats: { glyphs_active: 5 },
                updatedAt: "2025-01-01T00:01:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(prev, next);
      expect(items).toHaveLength(1);
      expect(items[0]?.source).toBe("hermes");
      expect(items[0]?.text).toBe("My Project · glyphs_active +2");
    });

    it("detects negative delta (decrease)", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "vellum",
                kind: "project",
                title: "Vellum",
                stats: { sessions: 10 },
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "vellum",
                kind: "project",
                title: "Vellum",
                stats: { sessions: 7 },
                updatedAt: "2025-01-01T00:01:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(prev, next);
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toBe("Vellum · sessions -3");
    });

    it("detects source ok:false → ok:true flip", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: false,
            error: "connection failed",
            entities: [],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: true,
            entities: [],
          },
        ],
      };

      const items = comparePulse(prev, next);
      expect(items).toHaveLength(1);
      expect(items[0]?.source).toBe("hermes");
      expect(items[0]?.text).toBe("hermes back online");
    });

    it("detects source ok:true → ok:false flip", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: false,
            error: "timeout",
            entities: [],
          },
        ],
      };

      const items = comparePulse(prev, next);
      expect(items).toHaveLength(1);
      expect(items[0]?.source).toBe("hermes");
      expect(items[0]?.text).toBe("hermes went stale");
    });

    it("uses key as title when title is undefined", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "proj-no-title",
                kind: "project",
                stats: { glyphs_active: 1 },
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "proj-no-title",
                kind: "project",
                stats: { glyphs_active: 2 },
                updatedAt: "2025-01-01T00:01:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(prev, next);
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toBe("proj-no-title · glyphs_active +1");
    });

    it("handles multiple entities in one hermes snapshot", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "host:agent-a",
                kind: "agent",
                title: "Agent A",
                stats: { glyphs_active: 2 },
                updatedAt: "2025-01-01T00:00:00Z",
              },
              {
                source: "hermes",
                key: "host:agent-b",
                kind: "agent",
                title: "Agent B",
                stats: { sessions: 5 },
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "host:agent-a",
                kind: "agent",
                title: "Agent A",
                stats: { glyphs_active: 4 },
                updatedAt: "2025-01-01T00:01:00Z",
              },
              {
                source: "hermes",
                key: "host:agent-b",
                kind: "agent",
                title: "Agent B",
                stats: { sessions: 8 },
                updatedAt: "2025-01-01T00:01:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(prev, next);
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.text)).toContainEqual("Agent A · glyphs_active +2");
      expect(items.map((i) => i.text)).toContainEqual("Agent B · sessions +3");
    });

    it("skips broken bundles (ok:false)", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: false,
            error: "failed",
            entities: [],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: false,
            error: "still failed",
            entities: [],
          },
        ],
      };

      const items = comparePulse(prev, next);
      // No status flip (both false), so empty
      expect(items).toEqual([]);
    });

    it("skips entity stats if not present in prev", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "proj-1",
                kind: "project",
                title: "Project",
                stats: {},
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "proj-1",
                kind: "project",
                title: "Project",
                stats: { glyphs_active: 5 },
                updatedAt: "2025-01-01T00:01:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(prev, next);
      expect(items).toEqual([]);
    });

    it("ignores entities not in prev (new entities)", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "proj-1",
                kind: "project",
                title: "Project 1",
                stats: { glyphs_active: 2 },
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "proj-1",
                kind: "project",
                title: "Project 1",
                stats: { glyphs_active: 2 },
                updatedAt: "2025-01-01T00:01:00Z",
              },
              {
                source: "hermes",
                key: "proj-2",
                kind: "project",
                title: "Project 2",
                stats: { glyphs_active: 3 },
                updatedAt: "2025-01-01T00:01:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(prev, next);
      // Only proj-1 is tracked since proj-2 is new
      expect(items).toEqual([]);
    });

    it("handles multiple stats on same entity", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "prism",
                kind: "project",
                title: "Prism",
                stats: { glyphs_active: 2, signals: 1, workflows: 5 },
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "prism",
                kind: "project",
                title: "Prism",
                stats: { glyphs_active: 4, signals: 1, workflows: 5 },
                updatedAt: "2025-01-01T00:01:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(prev, next);
      // Only glyphs_active changed
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toBe("Prism · glyphs_active +2");
    });

    it("handles string stat values (parsed to number)", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "review-1",
                kind: "review",
                title: "Code Review",
                stats: { comments: "5" },
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "review-1",
                kind: "review",
                title: "Code Review",
                stats: { comments: "8" },
                updatedAt: "2025-01-01T00:01:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(prev, next);
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toBe("Code Review · comments +3");
    });

    it("ignores non-numeric string stats", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "identity-1",
                kind: "identity",
                title: "Agent",
                stats: { status: "ready", label: "production" },
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "identity-1",
                kind: "identity",
                title: "Agent",
                stats: { status: "running", label: "staging" },
                updatedAt: "2025-01-01T00:01:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(prev, next);
      expect(items).toEqual([]);
    });

    it("each item has unique id with timestamp", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "proj-1",
                kind: "project",
                stats: { glyphs_active: 1 },
                updatedAt: "2025-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "proj-1",
                kind: "project",
                stats: { glyphs_active: 2 },
                updatedAt: "2025-01-01T00:01:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(prev, next);
      expect(items).toHaveLength(1);
      expect(items[0]?.id).toMatch(/hermes-proj-1-glyphs_active-\d+/);
      expect(items[0]?.at).toBeGreaterThan(0);
      expect(typeof items[0]?.at).toBe("number");
    });

    it("handles new entity keys with no prior row (skipped, not errored)", () => {
      const prev: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:00:00Z",
            ok: true,
            entities: [],
          },
        ],
      };

      const next: SnapshotState = {
        bundles: [
          {
            source: "hermes",
            fetchedAt: "2025-01-01T00:01:00Z",
            ok: true,
            entities: [
              {
                source: "hermes",
                key: "host:new-agent",
                kind: "agent",
                title: "New Agent",
                stats: { sessions: 5 },
                updatedAt: "2025-01-01T00:01:00Z",
              },
            ],
          },
        ],
      };

      const items = comparePulse(prev, next);
      // New entity keys have no prior row — no delta emitted
      expect(items).toEqual([]);
    });
  });
});
