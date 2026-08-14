import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  reviveTermAuthSeatState,
  reviveTermHostEvent,
} from "../src/main/vellum/term/control-client";
import {
  mergeSeatStateSnapshot,
  rememberRemoteSeatState,
  resetRemoteSeatState,
} from "../src/main/vellum/term/remote-seat-state";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";

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
    const plane = readFileSync("src/main/vellum/term/plane.ts", "utf8");
    const startAt = plane.indexOf("start = async");
    const suspendAt = plane.indexOf("suspendForLicenseRevocation");
    const shutdownAt = plane.indexOf("beginShutdown(reason");
    expect(startAt).toBeGreaterThan(-1);
    expect(suspendAt).toBeGreaterThan(startAt);
    expect(shutdownAt).toBeGreaterThan(suspendAt);
    expect(plane.slice(startAt, suspendAt)).toContain("seatStateRuntime.start()");
    expect(plane.slice(startAt, suspendAt)).not.toContain("seatStateRuntime.stop()");
    expect(plane.slice(suspendAt, shutdownAt)).not.toContain(
      "seatStateRuntime.stop()",
    );
    expect(plane.slice(shutdownAt)).toContain("seatStateRuntime.stop()");
  });

  it("caches hop-delivered events and hydrates the Command Center snapshot", () => {
    const termIpc = readFileSync("src/main/vellum/term/ipc.ts", "utf8");
    const ipc = readFileSync("src/main/vellum/ipc.ts", "utf8");
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
    const server = readFileSync("src/main/vellum/term/control-server.ts", "utf8");
    const client = readFileSync("src/main/vellum/term/control-client.ts", "utf8");
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
  });
});
