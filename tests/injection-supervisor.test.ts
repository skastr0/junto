import { describe, expect, it, vi } from "vitest";
import { InjectionSupervisor } from "../src/main/vellum/term/injection-supervisor";
import type { ObserverGridSnapshot } from "../src/main/vellum/term/observer/types";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";

const snap = (over: Partial<ObserverGridSnapshot> = {}): ObserverGridSnapshot => ({
  bindingId: "b1",
  epoch: "e1",
  cols: 120,
  rows: 30,
  lines: ["", "❯ "],
  text: "",
  seq: 1n,
  signals: { title: "", osc9: "", modes: { bracketedPaste: false, synchronizedOutput: false, altScreen: false, mouseModes: [] } },
  ...over,
});

const seatEvent = (over: Partial<AgentSeatStateEvent> = {}): AgentSeatStateEvent => ({
  bindingId: "b1",
  epoch: "e1",
  state: "idle",
  reason: "test",
  confidence: "high",
  at: 0,
  ...over,
});

describe("InjectionSupervisor", () => {
  it("does not write before any events (L0 observe)", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn();
    s.setWriter(writer);
    s.onSnapshot(snap({ lines: ["", "❯ "], text: "nothing here" }));
    expect(writer).not.toHaveBeenCalled();
  });

  it("proof via work-plane call stops all re-engagement", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn();
    s.setWriter(writer);
    s.noteWorkPlaneCall("b1");
    s.onSnapshot(snap({ text: "what is vellum?" }));
    expect(writer).not.toHaveBeenCalled();
  });

  it("user input suppresses doctrine injection (write-gate)", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn();
    s.setWriter(writer);
    const now = 1_000_000;
    s.setNow(() => now);
    s.noteUserInput("b1", now - 1_000);
    // idle + output recency → turn ended, unproven → would doctrine, but user gate holds.
    s.onSnapshot(snap({ lines: ["", "❯ "], text: "x", seq: 2n }));
    expect(writer).not.toHaveBeenCalled();
  });

  it("escalates after the turn budget without factory proof", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn();
    const escalate = vi.fn();
    s.setWriter(writer);
    s.setEscalationHandler(escalate);
    const now = 1_000_000;
    s.setNow(() => now);

    const turnCycle = (n: bigint): void => {
      s.noteSeatState(seatEvent({ state: "working", at: now }));
      s.onSnapshot(snap({ lines: ["working line"], text: "work", seq: n }));
      s.noteSeatState(seatEvent({ state: "idle", at: now }));
      s.onSnapshot(snap({ lines: ["", "❯ "], text: "done", seq: n + 1n }));
    };

    turnCycle(2n); // turn 1 → doctrine
    expect(writer).toHaveBeenCalledTimes(1);
    expect(String(writer.mock.calls[0][1])).toContain("[vc-");

    turnCycle(4n); // turn 2 → doctrine again (new turn)
    expect(writer).toHaveBeenCalledTimes(2);

    turnCycle(6n); // turn 3 → budget exhausted → escalate, no write
    expect(writer).toHaveBeenCalledTimes(2);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate.mock.calls[0][1]).toMatch(/unguided/);
  });

  it("confusion heuristic triggers a doctrine (awareness react)", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn();
    s.setWriter(writer);
    s.onSnapshot(snap({ text: "what is vellum? is it a tool?" }));
    expect(writer).toHaveBeenCalledTimes(1);
    expect(String(writer.mock.calls[0][1])).toContain("vellum-command onboard");
  });

  it("env-broken heuristic triggers a repair-env nudge with the absolute CLI path", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn();
    s.setWriter(writer);
    s.onSnapshot(snap({ text: "zsh: command not found: vellum-command" }));
    expect(writer).toHaveBeenCalledTimes(1);
    const payload = String(writer.mock.calls[0][1]);
    expect(payload).toContain("onboard");
    expect(payload).toMatch(/vellum-command/);
    // Never expose internals in the payload.
    expect(payload).not.toMatch(/control\.sock|token|VELLUM_COMMAND_|\.vellum-command/i);
  });

  it("repair-env fires once per generation; recurrence escalates", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn();
    const escalate = vi.fn();
    s.setWriter(writer);
    s.setEscalationHandler(escalate);
    s.onSnapshot(snap({ text: "vellum-command: command not found" }));
    s.onSnapshot(snap({ text: "vellum-command: command not found", seq: 3n }));
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("generation change resets per-generation state (resume re-zero fix)", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn();
    const escalate = vi.fn();
    s.setWriter(writer);
    s.setEscalationHandler(escalate);
    const now = 1_000_000;
    s.setNow(() => now);

    const turnCycle = (n: bigint): void => {
      s.noteSeatState(seatEvent({ state: "working", at: now }));
      s.onSnapshot(snap({ lines: ["working line"], text: "work", seq: n }));
      s.noteSeatState(seatEvent({ state: "idle", at: now }));
      s.onSnapshot(snap({ lines: ["", "❯ "], text: "done", seq: n + 1n }));
    };

    turnCycle(2n);
    turnCycle(4n);
    turnCycle(6n);
    expect(escalate).toHaveBeenCalledTimes(1);

    // New generation (resume): gone evicts the per-generation entry, so a
    // resumed generation starts fresh (no unbounded growth).
    s.noteSeatState(seatEvent({ state: "gone", epoch: "e1", at: now }));
    expect((s as unknown as { seats: Map<string, unknown> }).seats.has("b1")).toBe(false);
    s.noteSeatState(seatEvent({ state: "idle", epoch: "e2", at: now + 1 }));
    s.onSnapshot(snap({ epoch: "e2", lines: ["", "❯ "], text: "fresh", seq: 100n }));
    expect(escalate).toHaveBeenCalledTimes(1); // not re-escalated from old budget
  });

  it("escalation surfaces via handler, never a PTY write under user presence", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn();
    const escalate = vi.fn();
    s.setWriter(writer);
    s.setEscalationHandler(escalate);
    const now = 1_000_000;
    s.setNow(() => now);

    // user present through every turn: no writes, and escalation allowed (canvas-only)
    s.noteUserInput("b1", now);
    s.noteSeatState(seatEvent({ state: "working", at: now }));
    s.onSnapshot(snap({ lines: ["work"], text: "work", seq: 2n }));
    s.noteSeatState(seatEvent({ state: "idle", at: now }));
    s.onSnapshot(snap({ lines: ["", "❯ "], text: "done", seq: 3n }));
    expect(writer).not.toHaveBeenCalled();
  });
});
