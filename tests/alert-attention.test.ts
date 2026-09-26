import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectAlertSignals,
  collectReadyWorkingSignals,
  cycleAlertFocus,
  isTypingSurface,
  mergeCycleSignals,
  observeAlertSignals,
  resetAlertQueue,
  shouldCycleAlertOnKey,
} from "../src/renderer/lib/alert-attention";
import { alertId, cycleNext, emptyAlertQueue, observeSignals } from "../src/renderer/lib/alert-queue";
import * as sound from "../src/renderer/lib/sound";
import { state$ } from "../src/renderer/lib/state";
import type { RegionRollup } from "../src/shared/region-rollup";
import type { CanvasNode } from "../src/shared/canvas";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";

const rollup = (members: RegionRollup["members"]): RegionRollup => ({
  regionId: "r1",
  label: "forge",
  severity: "attention",
  counts: { total: members.length, blocked: 0, attention: 0, working: 0, ready: 0 },
  members,
});

describe("collectAlertSignals", () => {
  it("builds stable node signals for blocked, attention, and working members", () => {
    const signals = collectAlertSignals([
      rollup([
        { nodeId: "n-attention", label: "review", kind: "agent", severity: "attention", reasons: [] },
        { nodeId: "n-blocked", label: "deploy", kind: "task", severity: "blocked", reasons: [] },
        { nodeId: "n-working", label: "build", kind: "agent", severity: "working", reasons: [] },
        { nodeId: "n-idle", label: "idle", kind: "agent", severity: "idle", reasons: [] },
      ]),
    ]);

    expect(signals).toEqual([
      {
        id: alertId.node("n-attention"),
        kind: "attention",
        subjectKey: "n-attention",
        nodeId: "n-attention",
        label: "review",
        level: 3,
      },
      {
        id: alertId.node("n-blocked"),
        kind: "blocked",
        subjectKey: "n-blocked",
        nodeId: "n-blocked",
        label: "deploy",
        level: 4,
      },
      {
        id: alertId.node("n-working"),
        kind: "working",
        subjectKey: "n-working",
        nodeId: "n-working",
        label: "build",
        level: 1,
      },
    ]);
  });

  it("dedupes overlapping members and retains the highest severity", () => {
    const signals = collectAlertSignals([
      rollup([{ nodeId: "shared", label: "first", kind: "agent", severity: "attention", reasons: [] }]),
      rollup([{ nodeId: "shared", label: "second", kind: "agent", severity: "blocked", reasons: [] }]),
    ]);

    expect(signals).toEqual([
      expect.objectContaining({ id: alertId.node("shared"), kind: "blocked", level: 4, label: "second" }),
    ]);
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

  it("baselines then rises with the matching cue, cycles with the navigate cue + focus", () => {
    const play = vi.spyOn(sound, "playCue").mockImplementation(() => "silent");
    const nodeId = "focus-me";
    state$.doc.set({
      nodes: [{ id: nodeId, type: "text", x: 0, y: 0, width: 80, height: 40, text: "blocked" }],
      edges: [],
    });
    const signal = {
      id: alertId.node(nodeId), kind: "blocked" as const, subjectKey: nodeId, nodeId, label: "blocked", level: 2,
    };

    observeAlertSignals([signal]);
    expect(play).not.toHaveBeenCalled();
    expect(cycleAlertFocus()).toBe(false);

    observeAlertSignals([]);
    observeAlertSignals([signal]);
    expect(play).toHaveBeenCalledWith("blocked", { subject: nodeId });

    play.mockClear();
    expect(cycleAlertFocus()).toBe(true);
    expect(play).toHaveBeenCalledWith("navigate");
    expect(state$.focusNodeId.peek()).toBe(nodeId);
    expect(state$.selectedNodeId.peek()).toBe(nodeId);
    expect(state$.selectedNodeIds.peek()).toEqual([nodeId]);
  });

  it("sounds waiting on you for an attention rise", () => {
    const play = vi.spyOn(sound, "playCue").mockImplementation(() => "silent");
    const signal = { id: alertId.node("n1"), kind: "attention" as const, subjectKey: "n1", nodeId: "n1", level: 1 };
    observeAlertSignals([]);
    observeAlertSignals([signal]);
    expect(play).toHaveBeenCalledWith("waiting", { subject: "n1" });
  });

  it("sounds done and started working, each for its own seat", () => {
    const play = vi.spyOn(sound, "playCue").mockImplementation(() => "silent");
    observeAlertSignals([]);
    observeAlertSignals([
      { id: alertId.node("r"), kind: "ready", subjectKey: "r", nodeId: "r", level: 2 },
      { id: alertId.node("w"), kind: "working", subjectKey: "w", nodeId: "w", level: 1 },
    ]);
    expect(play).toHaveBeenCalledWith("done", { subject: "r" });
    expect(play).toHaveBeenCalledWith("working", { subject: "w" });
  });

  it("stays quiet when a seat calms down (done back to working)", () => {
    const play = vi.spyOn(sound, "playCue").mockImplementation(() => "silent");
    const at = (kind: "ready" | "working", level: number) =>
      [{ id: alertId.node("s"), kind, subjectKey: "s", nodeId: "s", level }];
    observeAlertSignals(at("ready", 2));
    observeAlertSignals(at("working", 1));
    expect(play).not.toHaveBeenCalled();
  });
});

describe("ready/working cycle order", () => {
  it("collectReadyWorkingSignals maps seat done→ready, attention, and working", async () => {
    const { agentSeat$, resetAgentSeatState } = await import(
      "../src/renderer/lib/agent-seat-state"
    );
    resetAgentSeatState();
    agentSeat$.bindingIdByNodeId.set({
      "agent-1": "bind-1",
      "agent-2": "bind-2",
      "agent-3": "bind-3",
    });
    try {
      const nodes = [
        {
          id: "agent-1",
          type: "text",
          x: 0,
          y: 0,
          width: 80,
          height: 40,
          text: "coder",
        },
        {
          id: "agent-2",
          type: "text",
          x: 0,
          y: 0,
          width: 80,
          height: 40,
          text: "reviewer",
        },
        {
          id: "agent-3",
          type: "text",
          x: 0,
          y: 0,
          width: 80,
          height: 40,
          text: "blocked-writer",
        },
        {
          id: "flagged",
          type: "text",
          x: 0,
          y: 0,
          width: 80,
          height: 40,
          text: "flagged note",
          ether: { flags: ["attention"] },
        },
      ] as unknown as ReadonlyArray<CanvasNode>;
      const seats: Record<string, AgentSeatStateEvent> = {
        "bind-1": {
          bindingId: "bind-1",
          epoch: "e1",
          state: "idle",
          reason: "turn-end",
          confidence: "high",
          at: 1,
        },
        "bind-2": {
          bindingId: "bind-2",
          epoch: "e2",
          state: "working",
          reason: "turn",
          confidence: "high",
          at: 1,
        },
        "bind-3": {
          bindingId: "bind-3",
          epoch: "e3",
          state: "attention",
          reason: "needs-input",
          confidence: "high",
          at: 1,
        },
      };
      const signals = collectReadyWorkingSignals(nodes, seats, {
        "bind-1": true,
      });
      expect(signals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: "agent-1", kind: "ready" }),
          expect.objectContaining({ nodeId: "agent-2", kind: "working" }),
          // freestanding attention must enter Space cycle (not only region members)
          expect.objectContaining({ nodeId: "agent-3", kind: "attention" }),
          expect.objectContaining({ nodeId: "flagged", kind: "attention" }),
        ]),
      );
    } finally {
      resetAgentSeatState();
    }
  });

  it("cycle walks notifications then ready then working", () => {
    let q = observeSignals(emptyAlertQueue(), [], 1).queue;
    const merged = mergeCycleSignals(
      collectAlertSignals([
        rollup([
          { nodeId: "b", label: "b", kind: "agent", severity: "blocked", reasons: [] },
          { nodeId: "a", label: "a", kind: "agent", severity: "attention", reasons: [] },
          { nodeId: "w", label: "w", kind: "agent", severity: "working", reasons: [] },
        ]),
      ]),
      [
        {
          id: alertId.node("r"),
          kind: "ready",
          subjectKey: "r",
          nodeId: "r",
          label: "r",
          level: 2,
        },
      ],
    );
    q = observeSignals(q, merged, 2).queue;
    const order: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const step = cycleNext(q);
      q = step.queue;
      if (step.item?.nodeId) order.push(step.item.nodeId);
    }
    expect(order).toEqual(["b", "a", "r", "w"]);
  });
});

describe("shouldCycleAlertOnKey / isTypingSurface", () => {
  const bare = { repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: " ", code: "Space", target: null as EventTarget | null };
  const stubSurface = (match: boolean): EventTarget => ({
    closest: (selector: string) => match && (selector.includes(".xterm") || selector.includes("textarea") || selector.includes("native-terminal")) ? {} : null,
  }) as unknown as EventTarget;

  it("allows bare Space on the canvas", () => {
    expect(shouldCycleAlertOnKey(bare)).toBe(true);
  });

  it("refuses Shift+Space (Caps Lock typing chord)", () => {
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
