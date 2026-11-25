import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  reviveTermAuthSeatState,
  reviveTermHostEvent,
} from "../src/core/term/control-client";
import {
  makeRemoteSeatState,
  mergeSeatStateSnapshot,
  republishOnLinkLost,
  servedRemoteEvent,
  servedRemoteEvents,
} from "../src/core/term/remote-seat-state";
import type { InstallationId } from "../src/shared/installation-id";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import { sessionActorMatches } from "../src/shared/terminal";

const remoteHop = {
  type: "seat-state" as const,
  bindingId: "bind_remote",
  epoch: "e9",
  event: {
    bindingId: "bind_remote",
    epoch: "e9",
    state: "working" as const,
    reason: "rule:grid_thinking_working",
    confidence: "high" as const,
    at: 1_700_000_000_000,
    harness: "grok",
  },
};

const reviveRemote = () => {
  const revived = reviveTermHostEvent(remoteHop);
  if (revived?.type !== "seat-state") {
    throw new Error("expected a revived seat-state hop");
  }
  return revived;
};

const makeState = makeRemoteSeatState;

describe("term seat-state hop decode", () => {
  it("revives a Mini observer event for Command Center cards", () => {
    expect(reviveTermHostEvent(remoteHop)).toEqual(remoteHop);
  });

  it("drops a malformed seat-state frame", () => {
    expect(
      reviveTermHostEvent({
        type: "seat-state",
        bindingId: "bind_remote",
        epoch: "e9",
        event: { state: "working" },
      }),
    ).toBeUndefined();
  });

  it("revives auth-ack seatState into hop-shaped LocalHostEvents", () => {
    expect(reviveTermAuthSeatState({ seatState: [remoteHop.event] })).toEqual([
      remoteHop,
    ]);
  });

  it("drops malformed or missing auth-ack seatState entries", () => {
    expect(reviveTermAuthSeatState(undefined)).toEqual([]);
    expect(reviveTermAuthSeatState({})).toEqual([]);
    expect(
      reviveTermAuthSeatState({
        seatState: [{ state: "working" }, remoteHop.event],
      }),
    ).toEqual([remoteHop]);
  });
});

describe("term seat-state Command Center snapshot", () => {
  it("includes a revived Remote hop event the local runtime never saw", () => {
    const state = makeState();
    const revived = reviveRemote();
    state.remember(revived.event);
    expect(mergeSeatStateSnapshot([], state.events())).toEqual([revived.event]);
  });

  it("lets the spawn-host event win on the same bindingId", () => {
    const state = makeState();
    const revived = reviveRemote();
    state.remember(revived.event);
    const local: AgentSeatStateEvent = {
      ...revived.event,
      state: "idle",
      reason: "rule:grid_idle",
      at: 1_700_000_000_100,
    };
    expect(mergeSeatStateSnapshot([local], state.events())).toEqual([local]);
  });
});

describe("term seat-state placement wiring", () => {
  it("TermPlane starts the spawn-host evaluator and stops only on plane shutdown", () => {
    const plane = readFileSync("src/core/term/plane.ts", "utf8");
    const startAt = plane.indexOf("start = async");
    const shutdownAt = plane.indexOf("beginShutdown(reason");
    expect(startAt).toBeGreaterThan(-1);
    expect(shutdownAt).toBeGreaterThan(startAt);
    expect(plane.slice(startAt, shutdownAt)).toContain("seatStateRuntime.start()");
    expect(plane.slice(startAt, shutdownAt)).not.toContain("seatStateRuntime.stop()");
    expect(plane.slice(shutdownAt)).toContain("seatStateRuntime.stop()");
  });

  it("caches hop-delivered events and hydrates the Command Center snapshot", () => {
    const termIpc = readFileSync("src/app/term/ipc.ts", "utf8");
    // The core remembers each hop-delivered seat state where the plane is bound.
    expect(readFileSync("src/core/ops/term-ipc.ts", "utf8")).toContain("remoteState.remember(payload.event)");
    expect(termIpc).toContain(
      "gate?.broadcast(IPC_CHANNELS.agentSeatStateChanged, payload.event)",
    );
    // The snapshot the Command Center reads is the core's since e92f443b4:
    // the window asks ThreadsSeatStates, and the core merges the hops it
    // kept with the events its own plane saw.
    expect(readFileSync("src/core/ops/ipc-threads.ts", "utf8")).toContain(
      "ThreadsSeatStates: () => Effect.sync(() => mergeSeatStateSnapshot(seatStateRuntime.currentEvents(), remoteState.events()))",
    );
  });

  it("fans Mini seat-state to authed clients and validates on the hop", () => {
    const server = readFileSync("src/core/term/control-server.ts", "utf8");
    const client = readFileSync("src/core/term/control-client.ts", "utf8");
    expect(server).toContain("stopSeatState = seatStateRuntime.subscribe");
    expect(server).toContain("type: \"seat-state\"");
    expect(server).toContain("writeEvent(payload, authedClients)");
    expect(server).not.toContain("writeEvent(payload, admittedClients)");
    expect(server).toContain("authedClients.add(socket)");
    expect(server).toContain("authedClients.delete(socket)");
    expect(server).toContain("admittedClients.add(socket)");
    expect(server).toContain("seatStateRuntime.currentEvents()");
    expect(server).toContain("data: { seatState: snapshot }");
    expect(client).toContain("isAgentSeatState(ev.state)");
    expect(client).toContain("reviveTermAuthSeatState");
    expect(client).toContain("queueMicrotask");
    expect(client).toContain("input: TermControlActorSeatCommand");
    expect(client).toContain('op: "createAgentSeat",\n      ...input');
  });

  it("keeps the router as a client directory, not an actor occupy service", () => {
    const router = readFileSync("src/core/term/router.ts", "utf8");
    const server = readFileSync("src/core/term/control-server.ts", "utf8");
    const host = readFileSync("src/core/term/local-host.ts", "utf8");
    expect(router).toContain("async clientForOccupy(hostId: string)");
    expect(router).not.toContain("makeActorSeatOccupy");
    expect(router).not.toContain('from "./actor-seat-occupy"');
    expect(router).not.toContain("async createAgentSeat");

    const createRemoteStart = router.indexOf("private async createRemote");
    const createRemoteEnd = router.indexOf("async list(", createRemoteStart);
    expect(createRemoteStart).toBeGreaterThan(-1);
    expect(createRemoteEnd).toBeGreaterThan(createRemoteStart);
    const createRemote = router.slice(createRemoteStart, createRemoteEnd);
    expect(createRemote).toContain("client.create({");
    expect(createRemote).not.toContain("createAgentSeat");
    expect(createRemote).not.toContain("harness");
    expect(createRemote).not.toContain("agentKey");

    const createStart = server.indexOf('case "create":');
    const actorStart = server.indexOf('case "createAgentSeat":');
    expect(createStart).toBeGreaterThan(-1);
    expect(actorStart).toBeGreaterThan(createStart);
    const geographyCreate = server.slice(createStart, actorStart);
    expect(geographyCreate).toContain("host.create({");
    expect(geographyCreate).not.toContain("host.createAgentSeat(");

    expect(server).toContain('case "createAgentSeat"');
    expect(server).toContain("host.createAgentSeat({");
    expect(server).toContain("sessionActorMatches(existing, actor)");
    expect(server).toContain("sessionActorMatches(summary, actor)");
    expect(host).toContain("createAgentSeat(");
  });
});

describe("sessionActorMatches", () => {
  it("is the hop ack that Mini bound the actor", () => {
    expect(
      sessionActorMatches(
        { harness: "grok", agentKey: "mini:grok" },
        { harness: "grok", agentKey: "mini:grok" },
      ),
    ).toBe(true);
    expect(
      sessionActorMatches(undefined, { harness: "grok", agentKey: "mini:grok" }),
    ).toBe(false);
    expect(
      sessionActorMatches(
        { harness: undefined, agentKey: undefined },
        { harness: "grok", agentKey: "mini:grok" },
      ),
    ).toBe(false);
  });
});

describe("a remote seat's reading is served with whether it is current", () => {
  const mini = "mini-installation" as InstallationId;
  const studio = "studio-installation" as InstallationId;
  const event = (bindingId: string, at: number): AgentSeatStateEvent => ({ ...remoteHop.event, bindingId, at });

  it("is current while its machine's link holds, and not after the link is lost", () => {
    const state = makeState();
    state.publish(event("bind_a", 1), mini);
    expect(servedRemoteEvents(state)).toEqual([{ ...event("bind_a", 1), current: true }]);
    state.linkLost(mini);
    expect(servedRemoteEvents(state)).toEqual([{ ...event("bind_a", 1), current: false }]);
  });

  it("is not current when it was only remembered, with no machine", () => {
    const state = makeState();
    state.remember(event("bind_a", 1));
    expect(servedRemoteEvent(state, event("bind_a", 1)).current).toBe(false);
  });

  it("is current again once its machine reports after the loss", () => {
    const state = makeState();
    state.publish(event("bind_a", 1), mini);
    state.linkLost(mini);
    state.publish(event("bind_a", 2), mini);
    expect(servedRemoteEvents(state)).toEqual([{ ...event("bind_a", 2), current: true }]);
  });

  it("tells the window again, not current, of the lost machine's seats only, with the same epoch and time", () => {
    const state = makeState();
    state.publish(event("bind_a", 1), mini);
    state.publish(event("bind_b", 2), mini);
    state.publish(event("bind_c", 3), studio);
    const told: AgentSeatStateEvent[] = [];
    const stop = republishOnLinkLost(state, (served) => told.push(served));
    state.linkLost(mini);
    expect(told.map((served) => [served.bindingId, served.epoch, served.at, served.current]).sort()).toEqual([
      ["bind_a", "e9", 1, false],
      ["bind_b", "e9", 2, false],
    ]);
    stop();
    state.linkLost(studio);
    expect(told).toHaveLength(2);
  });

  it("serves a seat here with no current flag: the spawn host's event wins and is always current", () => {
    const state = makeState();
    state.publish(event("bind_a", 1), mini);
    const local: AgentSeatStateEvent = { ...event("bind_a", 5), state: "idle" };
    expect(mergeSeatStateSnapshot([local], servedRemoteEvents(state))).toEqual([local]);
  });
});
