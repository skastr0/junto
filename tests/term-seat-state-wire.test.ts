import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  reviveTermAuthSeatState,
  reviveTermHostEvent,
} from "../src/main/vellum-command/term/control-client";
import {
  mergeSeatStateSnapshot,
  rememberRemoteSeatState,
  resetRemoteSeatState,
} from "../src/main/vellum-command/term/remote-seat-state";
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

afterEach(() => {
  resetRemoteSeatState();
});

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
    const revived = reviveRemote();
    rememberRemoteSeatState(revived.event);
    expect(mergeSeatStateSnapshot([])).toEqual([revived.event]);
  });

  it("lets the spawn-host event win on the same bindingId", () => {
    const revived = reviveRemote();
    rememberRemoteSeatState(revived.event);
    const local: AgentSeatStateEvent = {
      ...revived.event,
      state: "idle",
      reason: "rule:grid_idle",
      at: 1_700_000_000_100,
    };
    expect(mergeSeatStateSnapshot([local])).toEqual([local]);
  });
});

describe("term seat-state placement wiring", () => {
  it("TermPlane starts the spawn-host evaluator and stops only on plane shutdown", () => {
    const plane = readFileSync("src/main/vellum-command/term/plane.ts", "utf8");
    const startAt = plane.indexOf("start = async");
    const shutdownAt = plane.indexOf("beginShutdown(reason");
    expect(startAt).toBeGreaterThan(-1);
    expect(shutdownAt).toBeGreaterThan(startAt);
    expect(plane.slice(startAt, shutdownAt)).toContain("seatStateRuntime.start()");
    expect(plane.slice(startAt, shutdownAt)).not.toContain("seatStateRuntime.stop()");
    expect(plane.slice(shutdownAt)).toContain("seatStateRuntime.stop()");
  });

  it("caches hop-delivered events and hydrates the Command Center snapshot", () => {
    const termIpc = readFileSync("src/main/vellum-command/term/ipc.ts", "utf8");
    const ipc = readFileSync("src/main/vellum-command/ipc.ts", "utf8");
    expect(termIpc).toContain("rememberRemoteSeatState(payload.event)");
    expect(termIpc).toContain(
      "gate?.broadcast(IPC_CHANNELS.agentSeatStateChanged, payload.event)",
    );
    expect(ipc).toContain(
      "mergeSeatStateSnapshot(seatStateRuntime.currentEvents())",
    );
    expect(ipc).toContain("ensureHostAvailable: ensureBoxHostAvailable,\n    broadcast,");
  });

  it("fans Mini seat-state to authed clients and validates on the hop", () => {
    const server = readFileSync("src/main/vellum-command/term/control-server.ts", "utf8");
    const client = readFileSync("src/main/vellum-command/term/control-client.ts", "utf8");
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
    const router = readFileSync("src/main/vellum-command/term/router.ts", "utf8");
    const server = readFileSync("src/main/vellum-command/term/control-server.ts", "utf8");
    const host = readFileSync("src/main/vellum-command/term/local-host.ts", "utf8");
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
