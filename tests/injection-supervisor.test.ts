import { describe, expect, it, vi } from "vitest";
import { InjectionSupervisor, type NoticeWriter } from "../src/main/junto/term/injection-supervisor";
import { buildBootstrapMarker } from "../src/shared/managed-terminal-injection";
import type { ObserverGridSnapshot } from "../src/main/junto/term/observer/types";
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
  const orientationSeat = (writer: NoticeWriter) => {
    const supervisor = new InjectionSupervisor();
    supervisor.setWriter(writer);
    supervisor.setNow(() => 1_000_000);
    let seq = 0n;
    const frame = (state: "idle" | "working", lines: string[], epoch = "e1") => {
      supervisor.noteSeatState(seatEvent({ state, epoch }));
      supervisor.onSnapshot(snap({ lines, text: lines.join("\n"), seq: ++seq, epoch }));
    };
    const turn = (epoch = "e1") => {
      frame("working", [`❯ ${buildBootstrapMarker("b1")}`], epoch);
      frame("idle", ["", "❯ "], epoch);
    };
    const draftThenEmpty = (epoch = "e1") => {
      frame("idle", ["", "❯ operator draft"], epoch);
      frame("idle", ["", "❯ "], epoch);
    };
    return { supervisor, turn, draftThenEmpty };
  };

  it("does not spend the orientation budget when transport refuses", () => {
    const writer = vi.fn<NoticeWriter>().mockReturnValueOnce(false).mockReturnValue(true);
    const { turn, draftThenEmpty } = orientationSeat(writer);
    turn();
    turn();
    expect(writer).toHaveBeenCalledTimes(1);
    draftThenEmpty();
    expect(writer).toHaveBeenCalledTimes(2);
    draftThenEmpty();
    expect(writer).toHaveBeenCalledTimes(2);
  });

  it("reserves one orientation while its acceptance is unresolved", async () => {
    let accept!: (value: boolean) => void;
    const writer = vi.fn<NoticeWriter>().mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { accept = resolve; }),
    ).mockReturnValue(true);
    const { turn, draftThenEmpty } = orientationSeat(writer);
    turn();
    turn();
    turn();
    turn();
    expect(writer).toHaveBeenCalledTimes(1);
    accept(true);
    await Promise.resolve();
    draftThenEmpty();
    expect(writer).toHaveBeenCalledTimes(2);
  });

  it.each(["throw", "reject"] as const)("keeps a %s from spending the delivery budget", async (failure) => {
    const writer = vi.fn<NoticeWriter>().mockImplementationOnce(() => {
      if (failure === "throw") throw new Error("transport failed");
      return Promise.reject(new Error("transport failed"));
    }).mockReturnValue(true);
    const { turn, draftThenEmpty } = orientationSeat(writer);
    turn();
    expect(() => turn()).not.toThrow();
    await Promise.resolve();
    draftThenEmpty();
    expect(writer).toHaveBeenCalledTimes(2);
  });

  it("does not let an old completion release the new generation's reservation", async () => {
    const accept: Array<(value: boolean) => void> = [];
    const writer = vi.fn<NoticeWriter>().mockImplementation(
      () => new Promise<boolean>((resolve) => { accept.push(resolve); }),
    );
    const { supervisor, turn, draftThenEmpty } = orientationSeat(writer);
    turn();
    turn();
    supervisor.noteSeatState(seatEvent({ state: "gone" }));
    turn("e2");
    turn("e2");
    accept[0]!(true);
    await Promise.resolve();
    turn("e2");
    turn("e2");
    expect(writer).toHaveBeenCalledTimes(2);
    accept[1]!(true);
    await Promise.resolve();
    draftThenEmpty("e2");
    expect(writer).toHaveBeenCalledTimes(3);
    accept[2]!(true);
    await Promise.resolve();
  });

  it("does not write before any events (L0 observe)", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn<NoticeWriter>().mockReturnValue(true);
    s.setWriter(writer);
    s.onSnapshot(snap({ lines: ["", "❯ "], text: "nothing here" }));
    expect(writer).not.toHaveBeenCalled();
  });

  it("proof via work-plane call stops all re-engagement", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn<NoticeWriter>().mockReturnValue(true);
    s.setWriter(writer);
    s.noteWorkPlaneCall("b1");
    s.onSnapshot(snap({ text: "what is junto?" }));
    expect(writer).not.toHaveBeenCalled();
  });

  it("user input suppresses doctrine injection (write-gate)", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn<NoticeWriter>().mockReturnValue(true);
    s.setWriter(writer);
    const now = 1_000_000;
    s.setNow(() => now);
    s.noteUserInput("b1", now - 1_000);
    // idle + output recency → turn ended, unproven → would doctrine, but user gate holds.
    s.onSnapshot(snap({ lines: ["", "❯ "], text: "x", seq: 2n }));
    expect(writer).not.toHaveBeenCalled();
  });

  it("re-orients on a budget, then escalates once, then keeps the floor", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn<NoticeWriter>().mockReturnValue(true);
    const escalate = vi.fn();
    s.setWriter(writer);
    s.setEscalationHandler(escalate);
    const now = 1_000_000;
    s.setNow(() => now);

    const marker = buildBootstrapMarker("b1");
    const turnCycle = (n: bigint): void => {
      // Marker-observed turn: our injection is live in the prompt box…
      s.noteSeatState(seatEvent({ state: "working", at: now }));
      s.onSnapshot(snap({ lines: [`❯ ${marker}`], text: marker, seq: n }));
      // …submits and completes: seat idle, marker cleared.
      s.noteSeatState(seatEvent({ state: "idle", at: now }));
      s.onSnapshot(snap({ lines: ["", "❯ "], text: "done", seq: n + 1n }));
    };

    // One quiet turn is ordinary work — nothing is written.
    turnCycle(2n);
    expect(writer).not.toHaveBeenCalled();

    // Second unproven turn: the seat is re-told where its factory CLI is.
    // This is the floor that a compaction-wiped seat needs; spawn-time
    // delivery is long gone from the harness's own context by now.
    turnCycle(5n);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(String(writer.mock.calls[0][1])).toMatch(/junto onboard/);

    // Budget exhausted: the operator hears about it, exactly once.
    turnCycle(8n);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate.mock.calls[0][1]).toMatch(/unguided/);

    // And escalation does not end the floor: the seat is still being given
    // the chance to fix itself two turns later.
    turnCycle(11n);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledTimes(2);
  });

  it("never writes the floor into a live operator surface", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn<NoticeWriter>().mockReturnValue(true);
    s.setWriter(writer);
    const now = 2_000_000;
    s.setNow(() => now);

    const marker = buildBootstrapMarker("b1");
    const turnCycle = (n: bigint, promptLine: string): void => {
      s.noteSeatState(seatEvent({ state: "working", at: now }));
      s.onSnapshot(snap({ lines: [`❯ ${marker}`], text: marker, seq: n }));
      s.noteSeatState(seatEvent({ state: "idle", at: now }));
      s.onSnapshot(snap({ lines: ["", promptLine], text: "done", seq: n + 1n }));
    };

    // Operator draft sitting in the composer across both turns: the notice
    // would append to their half-typed line, so it is never sent.
    turnCycle(2n, "❯ fix the parser");
    turnCycle(5n, "❯ fix the parser");
    expect(writer).not.toHaveBeenCalled();
  });

  it("generation change resets per-generation state (resume re-zero fix)", () => {
    const s = new InjectionSupervisor();
    const writer = vi.fn<NoticeWriter>().mockReturnValue(true);
    const escalate = vi.fn();
    s.setWriter(writer);
    s.setEscalationHandler(escalate);
    const now = 1_000_000;
    s.setNow(() => now);

    const marker = buildBootstrapMarker("b1");
    // law-aligned: pre-law counted markerless flips as turns → the product
    // law counts only marker-observed turns, so the turn cycle feeds the
    // marker through the live→cleared lifecycle.
    const turnCycle = (n: bigint): void => {
      s.noteSeatState(seatEvent({ state: "working", at: now }));
      s.onSnapshot(snap({ lines: [`❯ ${marker}`], text: marker, seq: n }));
      s.noteSeatState(seatEvent({ state: "idle", at: now }));
      s.onSnapshot(snap({ lines: ["", "❯ "], text: "done", seq: n + 1n }));
    };

    turnCycle(2n);
    turnCycle(5n);
    turnCycle(8n);
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
    const writer = vi.fn<NoticeWriter>().mockReturnValue(true);
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
