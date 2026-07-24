import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { AgentChatCoarse } from "../src/renderer/lib/chat-state";
import {
  chatActivityFeed,
  clueFromChatCoarse,
  flagsFromEther,
} from "../src/renderer/lib/occupancy-feed";

type Node = CanvasDoc["nodes"][number];

const coarse = (partial: Partial<AgentChatCoarse>): AgentChatCoarse => ({
  status: "idle",
  turnBusy: false,
  hasBusyTools: false,
  ...partial,
});

const agentNode = (id: string, agentKey: string, flags?: ReadonlyArray<"blocker" | "parked" | "attention">): Node => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  ether: { entity: { kind: "agent", name: agentKey }, ...(flags ? { flags } : {}) },
});

const plainNode = (id: string, flags?: ReadonlyArray<"blocker" | "parked" | "attention">): Node => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  ...(flags ? { ether: { flags } } : {}),
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

describe("flagsFromEther — document ether.flags -> OccupancyFlags", () => {
  it("absent or empty -> undefined (no phantom flags)", () => {
    expect(flagsFromEther(undefined)).toBeUndefined();
    expect(flagsFromEther([])).toBeUndefined();
  });

  it("parked / attention map through; blocker is not an occupancy flag", () => {
    expect(flagsFromEther(["parked"])).toEqual({ parked: true, attention: false });
    expect(flagsFromEther(["attention"])).toEqual({ parked: false, attention: true });
    expect(flagsFromEther(["blocker"])).toEqual({ parked: false, attention: false });
  });
});

describe("chatActivityFeed — whole-document ActivityFeedService producer", () => {
  const doc: CanvasDoc = {
    nodes: [
      agentNode("a1", "local:agentA"),
      plainNode("t1", ["parked"]),
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
      flags: undefined,
    });
  });

  it("resolves a flags-only node with no chat plane presence", () => {
    const feed = chatActivityFeed(doc, chat);
    expect(feed.clueFor("t1")).toEqual({
      hasOccupant: false,
      activity: undefined,
      flags: { parked: true, attention: false },
    });
  });

  it("returns undefined for a node with neither chat presence nor flags", () => {
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
