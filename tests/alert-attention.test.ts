import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectAlertSignals,
  cycleAlertFocus,
  isTypingSurface,
  observeAlertSignals,
  resetAlertQueue,
  shouldCycleAlertOnKey,
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

  it("collects managed-seat ready/complete as agent-done (herdr-done kind)", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "agent-1",
          type: "text",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          text: "worker",
          ether: {
            entity: { kind: "agent", name: "local:worker" },
            host: "local",
            terminal: {
              bindingId: "bind-ready",
              harness: "codex",
              label: "worker",
              launch: { kind: "shell" },
            },
          },
        },
        {
          id: "agent-2",
          type: "text",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          text: "quiet",
          ether: {
            entity: { kind: "agent", name: "local:quiet" },
            host: "local",
            terminal: {
              bindingId: "bind-quiet",
              harness: "codex",
              label: "quiet",
              launch: { kind: "shell" },
            },
          },
        },
      ],
      edges: [],
    };
    const signals = collectAlertSignals({
      doc,
      rollups: [],
      chat: {},
      herdrMeta: {},
      seatNeedsLook: {
        "bind-ready": true,
        "bind-quiet": false,
      },
      snapshots: { bundles: [] },
      orphans: [],
    });
    expect(signals.map((s) => s.id)).toEqual([alertId.agentDone("agent-1")]);
    expect(signals[0]).toMatchObject({
      kind: "herdr-done",
      nodeId: "agent-1",
      label: "worker",
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

describe("shouldCycleAlertOnKey / isTypingSurface", () => {
  const bare = {
    repeat: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: " ",
    code: "Space",
    target: null as EventTarget | null,
  };

  /** Duck-typed Element stub — vitest node env has no DOM. */
  const stubSurface = (match: boolean): EventTarget =>
    ({
      closest: (selector: string) =>
        match &&
        (selector.includes(".xterm") ||
          selector.includes("textarea") ||
          selector.includes("native-terminal") ||
          selector.includes("herdr-"))
          ? {}
          : null,
    }) as unknown as EventTarget;

  it("allows bare Space on the canvas", () => {
    expect(shouldCycleAlertOnKey(bare)).toBe(true);
  });

  it("refuses Shift+Space (Caps Lock typing chord)", () => {
    // Regression: Shift+Space must reach the PTY / text surface, not cycle alerts.
    // Caps Lock + Shift (for lowercase) then Space is a common dead chord.
    expect(shouldCycleAlertOnKey({ ...bare, shiftKey: true })).toBe(false);
  });

  it("refuses Space while focus is inside xterm chrome", () => {
    const target = stubSurface(true);
    expect(isTypingSurface(target)).toBe(true);
    expect(shouldCycleAlertOnKey({ ...bare, target })).toBe(false);
  });

  it("allows Space when target is not a typing surface", () => {
    const target = stubSurface(false);
    expect(isTypingSurface(target)).toBe(false);
    expect(shouldCycleAlertOnKey({ ...bare, target })).toBe(true);
  });
});
