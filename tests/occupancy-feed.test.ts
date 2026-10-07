import { beforeEach, describe, expect, it } from "vitest";
import type { AgentChatCoarse, AgentChatState } from "../src/renderer/lib/chat-state";
import {
  chatCoarse$,
  initialAgentChatState,
  setAgentChatState,
} from "../src/renderer/lib/chat-state";
import {
  attentionCoarse$,
  chatActivityFeedOf,
  clueFromChatCoarse,
} from "../src/renderer/lib/occupancy-feed";

const coarse = (partial: Partial<AgentChatCoarse>): AgentChatCoarse => ({
  status: "idle",
  turnBusy: false,
  hasBusyTools: false,
  ...partial,
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

describe("chatActivityFeedOf — the feed for the seats on a canvas", () => {
  const seats = [{ id: "a1", agentKey: "local:agentA" }];
  const chat: Record<string, AgentChatCoarse> = {
    "local:agentA": coarse({ status: "live" }),
  };

  it("resolves a seat via chatCoarse", () => {
    const feed = chatActivityFeedOf(seats, chat);
    expect(feed.clueFor("a1")).toEqual({
      hasOccupant: true,
      activity: { harness: "idle" },
    });
  });

  it("returns undefined for a node that is not a seat", () => {
    const feed = chatActivityFeedOf(seats, chat);
    expect(feed.clueFor("t2")).toBeUndefined();
  });

  it("returns undefined for an unknown node id (never invents a seat)", () => {
    const feed = chatActivityFeedOf(seats, chat);
    expect(feed.clueFor("does-not-exist")).toBeUndefined();
  });

  it("degrades to vacant for a canvas with no seats", () => {
    const feed = chatActivityFeedOf([], chat);
    expect(feed.clueFor("a1")).toBeUndefined();
  });
});

describe("attentionCoarse$ — per-node subscription is keyed, not the whole map", () => {
  const permissionState = (requestId: string): AgentChatState => ({
    ...initialAgentChatState(),
    status: "live",
    pendingPermission: { requestId },
  });

  beforeEach(() => {
    chatCoarse$.set({});
  });

  it("one agent's permission flip never notifies another agent's node", () => {
    const keyA = `A-${Math.random()}`;
    const keyB = `B-${Math.random()}`;
    let notifiedB = 0;
    let notifiedWholeMap = 0;
    const offB = attentionCoarse$(keyB).onChange(() => {
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
    const off = attentionCoarse$(keyB).onChange(() => {
      observed.push(attentionCoarse$(keyB).peek()?.pendingPermissionId);
    });

    setAgentChatState(keyB, permissionState("p2"));
    off();

    expect(observed).toEqual(["p2"]);
  });

  it("subscribing before the key exists still delivers the first write", () => {
    const keyC = `C-${Math.random()}`;
    // Nothing has ever written this agent — the slice is created lazily.
    expect(attentionCoarse$(keyC).peek()).toBeUndefined();
    let notified = 0;
    const off = attentionCoarse$(keyC).onChange(() => {
      notified += 1;
    });

    setAgentChatState(keyC, permissionState("p3"));
    off();

    expect(notified).toBe(1);
    expect(attentionCoarse$(keyC).peek()?.pendingPermissionId).toBe("p3");
  });

  it("a caller with no seat parks on the shared sentinel and stays quiet", () => {
    const keyA = `A-${Math.random()}`;
    let notified = 0;
    const off = attentionCoarse$(undefined).onChange(() => {
      notified += 1;
    });

    setAgentChatState(keyA, permissionState("p4"));
    off();

    expect(notified).toBe(0);
    // The same sentinel slice useSeatOccupancyClue parks on: one no-agent
    // key, not a second invented one.
    expect(attentionCoarse$(undefined)).toBe(
      attentionCoarse$(undefined),
    );
  });

  it("re-seating re-keys: the old agent stops mattering, the new one lands", () => {
    const keyOld = `old-${Math.random()}`;
    const keyNew = `new-${Math.random()}`;
    setAgentChatState(keyOld, permissionState("p5"));
    expect(attentionCoarse$(keyOld).peek()?.pendingPermissionId).toBe("p5");
    expect(attentionCoarse$(keyNew).peek()).toBeUndefined();

    let notified = 0;
    const off = attentionCoarse$(keyNew).onChange(() => {
      notified += 1;
    });
    setAgentChatState(keyOld, permissionState("p6"));
    expect(notified).toBe(0);
    setAgentChatState(keyNew, permissionState("p7"));
    off();

    expect(notified).toBe(1);
    expect(attentionCoarse$(keyNew).peek()?.pendingPermissionId).toBe("p7");
  });
});
