import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSignal } from "../src/shared/agent-signals";
import {
  agentSignals$,
  reconcileRollups,
  replaceAgentSignals,
  seatSignalRollups$,
  startAgentSignalSync,
  upsertAgentSignal,
} from "../src/renderer/lib/agent-signals-state";
import { state$ } from "../src/renderer/lib/state";

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

  it("hydrates the open canvas and keeps live events that raced the listing", async () => {
    state$.canvasName.set("factory");
    let resolveList: (value: AgentSignal[]) => void = () => undefined;
    const api = {
      agentSignalsList: vi.fn(
        () => new Promise<AgentSignal[]>((resolve) => { resolveList = resolve; }),
      ),
      agentSignalRespond: vi.fn(),
      agentSignalDismiss: vi.fn(),
      onAgentSignal: vi.fn(() => () => undefined),
    };
    const stop = startAgentSignalSync(api as never);
    await vi.waitFor(() => expect(api.agentSignalsList).toHaveBeenCalledWith("factory"));
    upsertAgentSignal(signal({ signalId: "live", kind: "blocked", createdAt: 9 }));
    resolveList([signal({ signalId: "listed" })]);
    await vi.waitFor(() => {
      expect(Object.keys(agentSignals$.peek()).sort()).toEqual(["listed", "live"]);
    });
    stop();
  });
});
