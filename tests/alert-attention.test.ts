import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectAlertSignals,
  cycleAlertFocus,
  observeAlertSignals,
  resetAlertQueue,
} from "../src/renderer/lib/alert-attention";
import { alertId } from "../src/renderer/lib/alert-queue";
import * as sfx from "../src/renderer/lib/sfx";
import { state$ } from "../src/renderer/lib/state";
import type { CanvasDoc } from "../src/shared/canvas";
import type { SnapshotState } from "../src/shared/entities";
import type { RegionRollup } from "../src/shared/region-rollup";

const emptyDoc = (): CanvasDoc => ({ nodes: [], edges: [] });

describe("collectAlertSignals", () => {
  it("collects blocked members from rollups", () => {
    const rollups: RegionRollup[] = [
      {
        regionId: "r1",
        label: "forge",
        severity: "blocked",
        counts: { total: 2, blocked: 1, attention: 0, working: 0 },
        members: [
          {
            nodeId: "n-block",
            label: "prism",
            kind: "project",
            severity: "blocked",
            reasons: ["flag:blocker"],
          },
          {
            nodeId: "n-idle",
            label: "other",
            kind: "project",
            severity: "idle",
            reasons: [],
          },
        ],
      },
    ];
    const signals = collectAlertSignals({
      doc: emptyDoc(),
      rollups,
      chat: {},
      herdrMeta: {},
      snapshots: { bundles: [] },
      orphans: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id: alertId.blocked("n-block"),
      kind: "blocked",
      nodeId: "n-block",
    });
  });

  it("resolves permission agentKey to agent node id", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "agent-node",
          type: "text",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          text: "bot",
          ether: { entity: { kind: "agent", name: "local:bot" } },
        },
      ],
      edges: [],
    };
    const signals = collectAlertSignals({
      doc,
      rollups: [],
      chat: {
        "local:bot": { pendingPermission: { requestId: "req-1" } },
        "other:x": {},
      },
      herdrMeta: {},
      snapshots: { bundles: [] },
      orphans: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id: alertId.permission("local:bot"),
      kind: "permission",
      nodeId: "agent-node",
    });
  });

  it("collects herdr-done by agentStatus", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "h1",
          type: "text",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          text: "pane",
          ether: { entity: { kind: "herdr" }, herdr: { host: "local" } },
        },
      ],
      edges: [],
    };
    const signals = collectAlertSignals({
      doc,
      rollups: [],
      chat: {},
      herdrMeta: {
        h1: { meta: { agentStatus: "done" } },
        h2: { meta: { agentStatus: "working" } },
      },
      snapshots: { bundles: [] },
      orphans: [],
    });
    expect(signals.map((s) => s.id)).toEqual([alertId.herdrDone("h1")]);
    expect(signals[0]?.nodeId).toBe("h1");
  });

  it("collects booth pending with level and project node focus", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "proj-1",
          type: "text",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          text: "prism",
          ether: { entity: { kind: "project", name: "prism" } },
        },
      ],
      edges: [],
    };
    const snapshots: SnapshotState = {
      bundles: [
        {
          source: "booth",
          fetchedAt: "2025-01-01T00:00:00Z",
          ok: true,
          entities: [
            {
              source: "booth",
              key: "prism",
              kind: "project",
              title: "Prism",
              stats: { pending_review: 3 },
              updatedAt: "2025-01-01T00:00:00Z",
            },
            {
              source: "booth",
              key: "quiet",
              kind: "project",
              title: "Quiet",
              stats: { pending_review: 0 },
              updatedAt: "2025-01-01T00:00:00Z",
            },
          ],
        },
      ],
    };
    const signals = collectAlertSignals({
      doc,
      rollups: [],
      chat: {},
      herdrMeta: {},
      snapshots,
      orphans: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id: alertId.boothReview("prism"),
      kind: "booth-review",
      level: 3,
      nodeId: "proj-1",
    });
  });

  it("collects orphans and resolves region id when present", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "region-alive",
          type: "group",
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          label: "alive",
        },
      ],
      edges: [],
    };
    const signals = collectAlertSignals({
      doc,
      rollups: [],
      chat: {},
      herdrMeta: {},
      snapshots: { bundles: [] },
      orphans: ["canvas-a::region-alive", "canvas-b::gone"],
    });
    expect(signals).toHaveLength(2);
    const alive = signals.find((s) => s.subjectKey === "canvas-a::region-alive");
    const gone = signals.find((s) => s.subjectKey === "canvas-b::gone");
    expect(alive?.nodeId).toBe("region-alive");
    expect(gone?.nodeId).toBeUndefined();
  });

  it("dedupes blocked member across overlapping regions", () => {
    const member = {
      nodeId: "shared",
      label: "x",
      kind: "project",
      severity: "blocked" as const,
      reasons: ["flag:blocker"],
    };
    const rollups: RegionRollup[] = [
      {
        regionId: "r1",
        label: "a",
        severity: "blocked",
        counts: { total: 1, blocked: 1, attention: 0, working: 0 },
        members: [member],
      },
      {
        regionId: "r2",
        label: "b",
        severity: "blocked",
        counts: { total: 1, blocked: 1, attention: 0, working: 0 },
        members: [member],
      },
    ];
    const signals = collectAlertSignals({
      doc: emptyDoc(),
      rollups,
      chat: {},
      herdrMeta: {},
      snapshots: { bundles: [] },
      orphans: [],
    });
    expect(signals).toHaveLength(1);
  });
});

describe("observeAlertSignals + cycleAlertFocus", () => {
  afterEach(() => {
    resetAlertQueue();
    vi.restoreAllMocks();
    state$.doc.set({ nodes: [], edges: [] });
    state$.selectedNodeId.set("");
    state$.selectedNodeIds.set([]);
    state$.selectedEdgeId.set("");
    state$.focusNodeId.set("");
  });

  it("baselines then rises with matching sfx, cycles with cycle sfx + focus", () => {
    const play = vi.spyOn(sfx, "playAlert").mockImplementation(() => undefined);
    const nodeId = "focus-me";
    state$.doc.set({
      nodes: [
        {
          id: nodeId,
          type: "text",
          x: 0,
          y: 0,
          width: 80,
          height: 40,
          text: "blocked",
        },
      ],
      edges: [],
    });

    const signal = {
      id: alertId.blocked(nodeId),
      kind: "blocked" as const,
      subjectKey: nodeId,
      nodeId,
      label: "blocked",
    };

    observeAlertSignals([signal]); // baseline — no sfx, no cycle target
    expect(play).not.toHaveBeenCalled();
    expect(cycleAlertFocus()).toBe(false);

    observeAlertSignals([]); // clear known after baseline
    observeAlertSignals([signal]); // rise
    expect(play).toHaveBeenCalledWith("blocked");

    play.mockClear();
    const cycled = cycleAlertFocus();
    expect(cycled).toBe(true);
    expect(play).toHaveBeenCalledWith("cycle");
    expect(state$.focusNodeId.peek()).toBe(nodeId);
    expect(state$.selectedNodeId.peek()).toBe(nodeId);
    expect(state$.selectedNodeIds.peek()).toEqual([nodeId]);
  });

  it("cycle no-ops on empty queue", () => {
    const play = vi.spyOn(sfx, "playAlert").mockImplementation(() => undefined);
    expect(cycleAlertFocus()).toBe(false);
    expect(play).not.toHaveBeenCalled();
  });
});
