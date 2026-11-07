import { Deferred, Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignalsWindow } from "../src/contract/window/signals";
import type { AgentSignal } from "../src/shared/agent-signals";
import {
  agentSignals$,
  reconcileRollups,
  replaceAgentSignals,
  seatSignalRollups$,
  upsertAgentSignal,
} from "../src/window/lib/agent-signals-state";
import { AgentSignalsSync } from "../src/window/lib/agent-signals-sync";
import { state$ } from "../src/window/lib/state";

const signal = (over: Partial<AgentSignal>): AgentSignal => ({
  signalId: "s1",
  canvasName: "factory",
  nodeId: "a",
  kind: "feedback",
  text: "ready",
  createdAt: 1,
  state: "open",
  ...over,
});

afterEach(() => {
  replaceAgentSignals("", []);
  state$.canvasName.set("");
});

describe("reconcileRollups", () => {
  it("keeps an unchanged seat's rollup identity and replaces a changed one", () => {
    const first = reconcileRollups(new Map(), [
      signal({ signalId: "a1", nodeId: "a" }),
      signal({ signalId: "b1", nodeId: "b" }),
    ]);
    const second = reconcileRollups(first, [
      signal({ signalId: "a1", nodeId: "a" }),
      signal({ signalId: "b1", nodeId: "b" }),
      signal({ signalId: "b2", nodeId: "b", kind: "blocked", createdAt: 2 }),
    ]);
    expect(second.get("a")).toBe(first.get("a"));
    expect(second.get("b")).not.toBe(first.get("b"));
    expect(second.get("b")?.kind).toBe("blocked");
  });
});

describe("agent signal mirror", () => {
  it("applies upserts for the open canvas only and rolls them up per seat", () => {
    state$.canvasName.set("factory");
    upsertAgentSignal(signal({ signalId: "s1", kind: "escalate" }));
    upsertAgentSignal(signal({ signalId: "other", canvasName: "elsewhere" }));
    expect(Object.keys(agentSignals$.peek())).toEqual(["s1"]);
    expect(seatSignalRollups$.get().a?.kind).toBe("escalate");

    upsertAgentSignal(signal({ signalId: "s1", kind: "escalate", state: "answered" }));
    expect(seatSignalRollups$.get().a).toBeUndefined();
  });

  it("hydrates the open canvas and keeps live changes that raced the listing", async () => {
    state$.canvasName.set("factory");
    const listing = Effect.runSync(Deferred.make<ReadonlyArray<AgentSignal>>());
    const changes = Effect.runSync(Queue.unbounded<AgentSignal>());
    const list = vi.fn(() => Deferred.await(listing));
    const client = { SignalsList: list, SignalsChanged: () => Stream.fromQueue(changes) };
    const runtime = ManagedRuntime.make(AgentSignalsSync.layer.pipe(Layer.provide(Layer.succeed(SignalsWindow, client as never))));
    await runtime.runPromise(AgentSignalsSync);
    await vi.waitFor(() => expect(list).toHaveBeenCalledWith({ canvasName: "factory" }));
    Queue.offerUnsafe(changes, signal({ signalId: "live", kind: "blocked", createdAt: 9 }));
    await vi.waitFor(() => expect(Object.keys(agentSignals$.peek())).toEqual(["live"]));
    Deferred.doneUnsafe(listing, Effect.succeed([signal({ signalId: "listed" })]));
    await vi.waitFor(() => {
      expect(Object.keys(agentSignals$.peek()).sort()).toEqual(["listed", "live"]);
    });

    // Another canvas: the store empties, and the core lists that one.
    state$.canvasName.set("elsewhere");
    await vi.waitFor(() => expect(list).toHaveBeenCalledWith({ canvasName: "elsewhere" }));
    await runtime.dispose();
  });
});
