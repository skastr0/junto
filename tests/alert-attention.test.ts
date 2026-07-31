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
import type { RegionRollup } from "../src/shared/region-rollup";

const rollup = (members: RegionRollup["members"]): RegionRollup => ({
  regionId: "r1",
  label: "forge",
  severity: "attention",
  counts: { total: members.length, blocked: 0, attention: 0, working: 0 },
  members,
});

describe("collectAlertSignals", () => {
  it("builds stable node signals for attention and blocked members", () => {
    const signals = collectAlertSignals([
      rollup([
        { nodeId: "n-attention", label: "review", kind: "agent", severity: "attention", reasons: [] },
        { nodeId: "n-blocked", label: "deploy", kind: "task", severity: "blocked", reasons: [] },
        { nodeId: "n-working", label: "build", kind: "agent", severity: "working", reasons: [] },
      ]),
    ]);

    expect(signals).toEqual([
      {
        id: alertId.node("n-attention"),
        kind: "attention",
        subjectKey: "n-attention",
        nodeId: "n-attention",
        label: "review",
        level: 1,
      },
      {
        id: alertId.node("n-blocked"),
        kind: "blocked",
        subjectKey: "n-blocked",
        nodeId: "n-blocked",
        label: "deploy",
        level: 2,
      },
    ]);
  });

  it("dedupes overlapping members and retains the highest severity", () => {
    const signals = collectAlertSignals([
      rollup([{ nodeId: "shared", label: "first", kind: "agent", severity: "attention", reasons: [] }]),
      rollup([{ nodeId: "shared", label: "second", kind: "agent", severity: "blocked", reasons: [] }]),
    ]);

    expect(signals).toEqual([
      expect.objectContaining({ id: alertId.node("shared"), kind: "blocked", level: 2, label: "second" }),
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

  it("baselines then rises with matching sfx, cycles with cycle sfx + focus", () => {
    const play = vi.spyOn(sfx, "playAlert").mockImplementation(() => undefined);
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
    expect(play).toHaveBeenCalledWith("blocked");

    play.mockClear();
    expect(cycleAlertFocus()).toBe(true);
    expect(play).toHaveBeenCalledWith("cycle");
    expect(state$.focusNodeId.peek()).toBe(nodeId);
    expect(state$.selectedNodeId.peek()).toBe(nodeId);
    expect(state$.selectedNodeIds.peek()).toEqual([nodeId]);
  });

  it("uses the attention sound for an attention rise", () => {
    const play = vi.spyOn(sfx, "playAlert").mockImplementation(() => undefined);
    const signal = { id: alertId.node("n1"), kind: "attention" as const, subjectKey: "n1", nodeId: "n1", level: 1 };
    observeAlertSignals([]);
    observeAlertSignals([signal]);
    expect(play).toHaveBeenCalledWith("permission");
  });
});

describe("shouldCycleAlertOnKey / isTypingSurface", () => {
  const bare = { repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: " ", code: "Space", target: null as EventTarget | null };
  const stubSurface = (match: boolean): EventTarget => ({
    closest: (selector: string) => match && (selector.includes(".xterm") || selector.includes("textarea") || selector.includes("native-terminal") || selector.includes("herdr-")) ? {} : null,
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
