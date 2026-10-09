import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../src/shared/terminal";
import { SeatStateRuntime } from "../src/main/junto/term/agent-state";
import { ClosingFence } from "../src/main/junto/term/closing-fence";
import { createCoreMailTransport } from "../src/main/junto/term/core-mail";
import { CR, encodeBracketedPaste } from "../src/main/junto/term/drive";
import { InjectionSupervisor } from "../src/main/junto/term/injection-supervisor";
import type { LocalHostEvent, LocalSessionHost } from "../src/main/junto/term/local-host";
import type { ObserverGridSnapshot, ObserverListener } from "../src/main/junto/term/observer";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  vi.useRealTimers();
});

const fixture = () => {
  const bindingId = "mail-seat";
  let live: TerminalSessionSummary | undefined = {
    bindingId, hostId: "mini", epoch: "generation-1", status: "running",
    createdAt: 0, detached: false, harness: "codex", agentKey: "mini:mail-seat",
    canvasName: "copy", nodeId: "agent-mail",
  };
  let snapshot: ObserverGridSnapshot = {
    bindingId, epoch: "generation-1", cols: 80, rows: 24, seq: 1n,
    lines: ["› "], text: "› ",
    signals: { title: "", osc9: "", modes: { bracketedPaste: false,
      synchronizedOutput: false, altScreen: false, mouseModes: [] } },
  };
  const state = new SeatStateRuntime();
  state.bindHarness(bindingId, "codex", "generation-1");
  state.machine.force(bindingId, "idle", "fixture-ready");
  vi.spyOn(state, "composerVerdict").mockReturnValue("empty");
  const hostListeners = new Set<(event: LocalHostEvent) => void>();
  const observers = new Set<ObserverListener>();
  const supervisor = new InjectionSupervisor();
  const fence = new ClosingFence();
  const delivery = { onSeatLive: vi.fn(), suspend: vi.fn() };
  const wakeSeat = vi.fn(async () => true);
  const host: Pick<LocalSessionHost, "get" | "writeManagedSeat" | "setInputSealed" | "subscribeEvents"> = {
    get: () => live,
    setInputSealed: vi.fn(),
    subscribeEvents: (listener) => {
      hostListeners.add(listener);
      return () => { hostListeners.delete(listener); };
    },
    writeManagedSeat: vi.fn((_binding, data) => {
      if (data === CR) {
        snapshot = { ...snapshot, text: "› ", lines: ["› "] };
        state.machine.force(bindingId, "working", "fixture-submitted");
      }
      return true;
    }),
  };
  const seats = createCoreMailTransport({
    wakeSeat, host, state, fence, supervisor, delivery,
    bindDrive: vi.fn(), bindSuspension: vi.fn(),
    observer: {
      snapshot: () => snapshot,
      subscribeGlobal: (listener) => {
        observers.add(listener);
        return () => { observers.delete(listener); };
      },
    },
  });
  cleanup.push(seats.suspend);
  return {
    seats, state, host, fence, supervisor, delivery, wakeSeat, hostListeners, observers,
    setLive: (value: TerminalSessionSummary | undefined) => { live = value; },
    ready: (paste = true) => {
      snapshot = { ...snapshot, signals: { ...snapshot.signals,
        modes: { ...snapshot.signals.modes, bracketedPaste: paste } } };
      for (const listener of observers) listener(snapshot);
    },
  };
};

describe("core seat mail transport", () => {
  it("wakes a vacant local seat through the kernel and keeps the live generation", async () => {
    const f = fixture();
    f.setLive(undefined);
    expect(await f.seats.transport.wakeSeat?.("mail-seat", "copy", "agent-mail")).toBe(true);
    expect(f.wakeSeat).toHaveBeenCalledWith("mail-seat", "copy", "agent-mail");
    f.setLive({ bindingId: "mail-seat", epoch: "generation-2", status: "starting",
      hostId: "mini", createdAt: 0, detached: false });
    expect(await f.seats.transport.wakeSeat?.("mail-seat", "copy", "agent-mail")).toBe(true);
    expect(f.wakeSeat).toHaveBeenCalledOnce();
  });

  it("waits for a real writable moment and announces it once per generation", () => {
    const f = fixture();
    expect(f.seats.transport.seatLive("mail-seat")).toBe(false);
    f.ready();
    expect(f.seats.transport.seatLive("mail-seat")).toBe(true);
    expect(f.delivery.onSeatLive).toHaveBeenCalledOnce();
    f.ready();
    expect(f.delivery.onSeatLive).toHaveBeenCalledOnce();
    f.state.machine.force("mail-seat", "working", "fixture-turn");
    expect(f.seats.transport.seatLive("mail-seat")).toBe(true);
    f.ready(false);
    expect(f.seats.transport.seatLive("mail-seat")).toBe(false);
    f.fence.seal("mail-seat");
    f.seats.setMailPolicy({ seatLive: () => true });
    f.ready();
    expect(f.seats.transport.seatLive("mail-seat")).toBe(false);
  });

  it("types mail through the same drive and records the first real message", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.ready();
    const note = vi.spyOn(f.supervisor, "noteMailWritten");
    const written = f.seats.transport.writeMail("mail-seat", "mail from the other machine");
    await vi.advanceTimersByTimeAsync(250);
    expect(await written).toBe("written");
    expect(vi.mocked(f.host.writeManagedSeat).mock.calls.map(call => call[1])).toEqual([
      encodeBracketedPaste("mail from the other machine"), CR,
    ]);
    expect(note).toHaveBeenCalledWith("mail-seat");
    f.supervisor.noteOnboarded("mail-seat");
    expect(f.seats.transport.seatOnboarded?.("mail-seat")).toBe(true);
  });

  it("cuts every writer and writable feed before shutdown without stopping a seat", async () => {
    const f = fixture();
    f.ready();
    const stopped = vi.fn();
    f.seats.onSuspend(stopped);
    f.seats.suspend();
    f.seats.suspend();
    expect(stopped).toHaveBeenCalledOnce();
    expect(f.delivery.suspend).toHaveBeenCalledOnce();
    expect(f.hostListeners.size).toBe(0);
    expect(f.observers.size).toBe(0);
    expect(f.seats.transport.seatLive("mail-seat")).toBe(false);
    expect(await f.seats.transport.writeMail("mail-seat", "late mail")).toBe("lost");
    expect(await f.seats.transport.wakeSeat?.("mail-seat", "copy", "agent-mail")).toBe(false);
    expect(f.host.writeManagedSeat).not.toHaveBeenCalled();
    expect(f.wakeSeat).not.toHaveBeenCalled();
    const late = vi.fn();
    f.seats.onSuspend(late);
    expect(late).toHaveBeenCalledOnce();
  });
});
