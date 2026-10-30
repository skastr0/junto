/**
 * Main keeps the two needs the renderer used to fill in: a finished turn is
 * unseen until the operator views the seat, and a signal the seat declared
 * rides its snapshot while it is open.
 */
import { describe, expect, it } from "vitest";
import { SeatStateMachine } from "../src/main/junto/term/agent-state";
import { SeatStateRuntime } from "../src/main/junto/term/agent-state/runtime";
import { wireSeatReports } from "../src/main/junto/term/agent-state/seat-reports";
import { agentSeatStatusOf, type AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import { topNeed } from "../src/shared/harness-domain";
import type { AgentSignal } from "../src/shared/wire/agent-signals";

const NOW = Date.UTC(2026, 9, 17, 12, 0);

const seat = () => {
  const machine = new SeatStateMachine({ now: () => NOW });
  const events: AgentSeatStateEvent[] = [];
  machine.subscribe((event) => events.push(event));
  machine.bind("b1", { harness: "claude", epoch: "e1" });
  return { machine, events, need: () => topNeed(machine.snapshot("b1")!).cause };
};

describe("a finished turn is unseen until the operator views the seat", () => {
  it("working to idle reads ready until viewed, and idle after", () => {
    const { machine, events, need } = seat();
    machine.force("b1", "working", "rule:live_status_line_working", "high");
    machine.force("b1", "idle", "rule:osc_title_idle", "high");
    expect(machine.snapshot("b1")?.turnUnseen).toEqual({ outcome: "completed", since: NOW });
    expect(need()).toBe("turn_unseen");
    expect(agentSeatStatusOf(events.at(-1))?.need.cause).toBe("turn_unseen");

    const viewed = machine.publishFact("b1", { signal: { _tag: "OperatorViewed" }, source: "system", fidelity: "native" });
    expect(viewed?.state).toBe("idle");
    expect(agentSeatStatusOf(viewed ?? undefined)?.snapshot.turnUnseen).toBeUndefined();
    expect(need()).toBe("idle");
    // Viewing again changes nothing, so nothing is published.
    expect(machine.publishFact("b1", { signal: { _tag: "OperatorViewed" }, source: "system", fidelity: "native" })).toBeNull();
  });

  it("settling at the prompt box is a title restore, not a turn's end", () => {
    const { machine, need } = seat();
    machine.force("b1", "working", "rule:osc_title_working", "high");
    machine.force("b1", "idle", "rule:composer_draft_idle", "high");
    expect(machine.snapshot("b1")?.turnUnseen).toBeUndefined();
    expect(need()).toBe("idle");
  });

  it("a seat that needed the operator and settles idle has a turn to see", () => {
    const { machine } = seat();
    machine.force("b1", "attention", "rule:bash_permission_prompt", "high");
    machine.force("b1", "idle", "rule:empty_prompt_idle", "high");
    expect(machine.snapshot("b1")?.turnUnseen?.outcome).toBe("completed");
  });

  it("the inferred end carries the screen, so an open richer channel owns the turn", () => {
    const { machine } = seat();
    machine.note("b1", { signal: { _tag: "ActivityObserved", activity: "working" }, source: "osc7501", fidelity: "native" });
    machine.force("b1", "working", "rule:osc_title_working", "high");
    machine.force("b1", "idle", "rule:osc_title_idle", "high");
    expect(machine.snapshot("b1")?.statusSource).toBe("osc7501");
    expect(machine.snapshot("b1")?.turnUnseen).toBeUndefined();
  });

  it("the runtime's view names the binding", () => {
    const runtime = new SeatStateRuntime({ now: () => NOW, turnProgressWatch: false });
    runtime.bindHarness("b1", "claude", "e1");
    runtime.machine.force("b1", "working", "rule:osc_title_working", "high");
    runtime.machine.force("b1", "idle", "rule:osc_title_idle", "high");
    expect(runtime.snapshot("b1")?.turnUnseen).toBeDefined();
    expect(runtime.viewed("b1")?.bindingId).toBe("b1");
    expect(runtime.snapshot("b1")?.turnUnseen).toBeUndefined();
    expect(runtime.viewed("nobody")).toBeNull();
    runtime.stop();
  });
});

const signal = (state: AgentSignal["state"], kind: AgentSignal["kind"] = "blocked"): AgentSignal => ({
  signalId: "s1",
  canvasName: "main",
  nodeId: "n1",
  kind,
  text: "Need the staging key",
  createdAt: NOW - 1000,
  state,
});

describe("a seat's declared signals ride its snapshot", () => {
  const wired = (open: ReadonlyArray<AgentSignal> = []) => {
    const runtime = new SeatStateRuntime({ now: () => NOW, turnProgressWatch: false });
    let changed: ((signal: AgentSignal) => void) | undefined;
    const sessions = [{ bindingId: "b1", epoch: "e1", canvasName: "main", nodeId: "n1", status: "running" }];
    let listed = 0;
    const dispose = wireSeatReports({
      sessions: () => {
        listed += 1;
        return sessions;
      },
      session: (bindingId) => sessions.find((session) => session.bindingId === bindingId),
      seatReported: (bindingId, report) => runtime.seatReported(bindingId, report),
      subscribeSeatState: (listener) => runtime.subscribe(listener),
      onSignalChanged: (listener) => {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
      signalsOf: async () => open,
    });
    return { runtime, raise: (s: AgentSignal) => changed?.(s), dispose, listed: () => listed };
  };

  it("opening and closing a signal is a SeatReported on the seat that raised it", () => {
    const { runtime, raise, dispose } = wired();
    runtime.bindHarness("b1", "claude", "e1");
    raise(signal("open"));
    expect(runtime.snapshot("b1")?.reports).toEqual([
      { kind: "blocked", signalId: "s1", text: "Need the staging key", since: NOW },
    ]);
    expect(topNeed(runtime.snapshot("b1")!).cause).toBe("seat_blocked");
    raise(signal("answered"));
    expect(runtime.snapshot("b1")?.reports).toEqual([]);
    raise({ ...signal("open"), nodeId: "other" });
    expect(runtime.snapshot("b1")?.reports).toEqual([]);
    dispose();
    runtime.stop();
  });

  it("a generation that binds picks up the signals already open on its seat", async () => {
    const { runtime, dispose } = wired([signal("open", "escalate"), { ...signal("answered"), signalId: "s0" }]);
    runtime.bindHarness("b1", "claude", "e1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.snapshot("b1")?.reports.map((report) => [report.signalId, report.kind])).toEqual([["s1", "escalate"]]);
    expect(topNeed(runtime.snapshot("b1")!).cause).toBe("seat_escalated");
    dispose();
    runtime.stop();
  });

  it("a seat state event reads its own session, never the whole list", async () => {
    const { runtime, dispose, listed } = wired([signal("open", "escalate")]);
    runtime.bindHarness("b1", "claude", "e1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.snapshot("b1")?.reports).toHaveLength(1);
    expect(listed()).toBe(0);
    dispose();
    runtime.stop();
  });
});
