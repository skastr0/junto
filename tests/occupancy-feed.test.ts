import { beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { AgentChatCoarse, AgentChatState } from "../src/renderer/lib/chat-state";
import {
  chatCoarse$,
  initialAgentChatState,
  setAgentChatState,
} from "../src/renderer/lib/chat-state";
import {
  attentionCoarse$,
  chatActivityFeed,
  clueFromChatCoarse,
} from "../src/renderer/lib/occupancy-feed";

type Node = CanvasDoc["nodes"][number];

const coarse = (partial: Partial<AgentChatCoarse>): AgentChatCoarse => ({
  status: "idle",
  turnBusy: false,
  hasBusyTools: false,
  ...partial,
});

const agentNode = (id: string, agentKey: string): Node => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  ether: { entity: { kind: "agent", name: agentKey } },
});

const plainNode = (id: string): Node => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 40,
});

describe("clueFromChatCoarse — ACP chat plane -> occupancy clue", () => {
  it("live session is process-bind presence -> occupant, idle harness", () => {
    expect(clueFromChatCoarse(coarse({ status: "live" }))).toEqual({
      hasOccupant: true,
      activity: { harness: "idle" },
    });
  });

  it("connecting counts as occupant (session is being established)", () => {
    expect(clueFromChatCoarse(coarse({ status: "connecting" })).hasOccupant).toBe(true);
    expect(clueFromChatCoarse(coarse({ status: "connecting" })).activity?.harness).toBe("working");
  });

  it("pending permission -> attention harness (same tone as ActivityMark)", () => {
    const clue = clueFromChatCoarse(coarse({ status: "live", pendingPermissionId: "req-1" }));
    expect(clue.activity?.harness).toBe("attention");
  });

  it("busy tool -> working harness", () => {
    const clue = clueFromChatCoarse(coarse({ status: "live", hasBusyTools: true }));
    expect(clue.activity?.harness).toBe("working");
  });

  it("error status -> blocked harness, no live session -> no occupant", () => {
    const clue = clueFromChatCoarse(coarse({ status: "error" }));
    expect(clue.activity?.harness).toBe("blocked");
    expect(clue.hasOccupant).toBe(false);
  });

  it("closed session -> idle harness, no occupant", () => {
    const clue = clueFromChatCoarse(coarse({ status: "closed" }));
    expect(clue.hasOccupant).toBe(false);
    expect(clue.activity?.harness).toBe("idle");
  });

  it("turnBusy alone counts as occupant even if status lags", () => {
    expect(clueFromChatCoarse(coarse({ status: "idle", turnBusy: true })).hasOccupant).toBe(true);
  });
});

describe("chatActivityFeed — whole-document ActivityFeedService producer", () => {
  const doc: CanvasDoc = {
    nodes: [
      agentNode("a1", "local:agentA"),
      plainNode("t2"),
    ],
    edges: [],
  };
  const chat: Record<string, AgentChatCoarse> = {
    "local:agentA": coarse({ status: "live" }),
  };

  it("resolves an agent node via chatCoarse", () => {
    const feed = chatActivityFeed(doc, chat);
    expect(feed.clueFor("a1")).toEqual({
      hasOccupant: true,
      activity: { harness: "idle" },
    });
  });

  it("returns undefined for a node with no chat presence", () => {
    const feed = chatActivityFeed(doc, chat);
    expect(feed.clueFor("t2")).toBeUndefined();
  });

  it("returns undefined for an unknown node id (never invents a seat)", () => {
    const feed = chatActivityFeed(doc, chat);
    expect(feed.clueFor("does-not-exist")).toBeUndefined();
  });

  it("degrades to vacant for an undefined document", () => {
    const feed = chatActivityFeed(undefined, chat);
    expect(feed.clueFor("a1")).toBeUndefined();
  });
});

describe("attentionCoarse$ — per-node subscription is keyed, not the whole map", () => {
  const permissionState = (requestId: string): AgentChatState => ({
    ...initialAgentChatState(),
    status: "live",
    pendingPermission: { requestId },
  });

  const seat = (agentKey: string): Node => agentNode(`node-${agentKey}`, agentKey);

  beforeEach(() => {
    chatCoarse$.set({});
  });

  it("one agent's permission flip never notifies another agent's node", () => {
    const keyA = `A-${Math.random()}`;
    const keyB = `B-${Math.random()}`;
    let notifiedB = 0;
    let notifiedWholeMap = 0;
    const offB = attentionCoarse$(seat(keyB)).onChange(() => {
      notifiedB += 1;
    });
    const offMap = chatCoarse$.onChange(() => {
      notifiedWholeMap += 1;
    });

    setAgentChatState(keyA, permissionState("p1"));

    offB();
    offMap();
    // The write is real: the whole-map subscription every per-node component
    // used to hold does wake. The keyed one does not.
    expect(notifiedWholeMap).toBeGreaterThan(0);
    expect(notifiedB).toBe(0);
  });

  it("a subscriber keyed to an agent still receives that agent's own write", () => {
    const keyB = `B-${Math.random()}`;
    const observed: Array<string | undefined> = [];
    const off = attentionCoarse$(seat(keyB)).onChange(() => {
      observed.push(attentionCoarse$(seat(keyB)).peek()?.pendingPermissionId);
    });

    setAgentChatState(keyB, permissionState("p2"));
    off();

    expect(observed).toEqual(["p2"]);
  });

  it("subscribing before the key exists still delivers the first write", () => {
    const keyC = `C-${Math.random()}`;
    // Nothing has ever written this agent — the slice is created lazily.
    expect(attentionCoarse$(seat(keyC)).peek()).toBeUndefined();
    let notified = 0;
    const off = attentionCoarse$(seat(keyC)).onChange(() => {
      notified += 1;
    });

    setAgentChatState(keyC, permissionState("p3"));
    off();

    expect(notified).toBe(1);
    expect(attentionCoarse$(seat(keyC)).peek()?.pendingPermissionId).toBe("p3");
  });

  it("a node with no agent key parks on the shared sentinel and stays quiet", () => {
    const keyA = `A-${Math.random()}`;
    let notified = 0;
    const off = attentionCoarse$(plainNode("plain")).onChange(() => {
      notified += 1;
    });

    setAgentChatState(keyA, permissionState("p4"));
    off();

    expect(notified).toBe(0);
    // Same sentinel slice `useNodeOccupancyClue` already parks on — one
    // no-agent key, not a second invented one.
    expect(attentionCoarse$(plainNode("other"))).toBe(
      attentionCoarse$(plainNode("plain")),
    );
  });

  it("re-seating re-keys: the old agent stops mattering, the new one lands", () => {
    const keyOld = `old-${Math.random()}`;
    const keyNew = `new-${Math.random()}`;
    const node = seat(keyOld);
    const reseated: Node = { ...node, ether: { entity: { kind: "agent", name: keyNew } } };

    setAgentChatState(keyOld, permissionState("p5"));
    expect(attentionCoarse$(node).peek()?.pendingPermissionId).toBe("p5");
    expect(attentionCoarse$(reseated).peek()).toBeUndefined();

    let notified = 0;
    const off = attentionCoarse$(reseated).onChange(() => {
      notified += 1;
    });
    setAgentChatState(keyOld, permissionState("p6"));
    expect(notified).toBe(0);
    setAgentChatState(keyNew, permissionState("p7"));
    off();

    expect(notified).toBe(1);
    expect(attentionCoarse$(reseated).peek()?.pendingPermissionId).toBe("p7");
  });
});
