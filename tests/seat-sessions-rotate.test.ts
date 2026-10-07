/** Rotating a seat onto a fresh session: the order of acts and every refusal. */
import { describe, expect, it } from "vitest";
import { rotateSeatSession, type RotatingSeat, type SeatRotatePorts } from "../src/main/junto/seat-sessions/rotate";

const seat = (over: Partial<RotatingSeat> = {}): RotatingSeat => ({
  canvasName: "c",
  bindingId: "bind-a",
  harness: "claude",
  sessionId: "s1",
  local: true,
  ...over,
});

const recorder = (found: RotatingSeat | undefined, overrides: Partial<SeatRotatePorts> = {}) => {
  const acts: string[] = [];
  const ports: SeatRotatePorts = {
    locate: async () => found,
    endSession: async (seatId, sessionId) => void acts.push(`end ${seatId} ${sessionId}`),
    reopenSession: async (seatId, sessionId) => void acts.push(`reopen ${seatId} ${sessionId}`),
    writeSessionId: async (_seat, seatId, next) => (acts.push(`write ${seatId} ${next ?? "(none)"}`), true),
    detach: async (found) => {
      acts.push(`detach ${found.bindingId}`);
      return { stopNow: async () => void acts.push(`stop ${found.bindingId}`) };
    },
    wake: async (_seat, seatId) => (acts.push(`wake ${seatId}`), true),
    mintSessionId: () => "fresh",
    ...overrides,
  };
  return { acts, ports };
};

describe("rotateSeatSession", () => {
  it("takes the old process off the seat first, then ends the session, pins a fresh id, and wakes", async () => {
    const { acts, ports } = recorder(seat());
    expect(await rotateSeatSession("a", ports)).toEqual({ ok: true, ended: "s1", next: "fresh", woke: true });
    // Detached before anything is awaited for the seat; never stopped here.
    expect(acts).toEqual(["detach bind-a", "end a s1", "write a fresh", "wake a"]);
  });

  it("tells the detach which session is ending, so its wind-down can be recorded", async () => {
    const seen: Array<string | undefined> = [];
    const { ports } = recorder(seat(), {
      detach: async (_seat, _seatId, ended) => {
        seen.push(ended);
        return { stopNow: async () => undefined };
      },
    });
    await rotateSeatSession("a", ports);
    await rotateSeatSession("a", recorder(seat({ sessionId: undefined }), { detach: ports.detach }).ports);
    expect(seen).toEqual(["s1", undefined]);
  });

  it("wakes without waiting for the old process to be gone", async () => {
    let oldProcessGone = false;
    const order: string[] = [];
    const { ports } = recorder(seat(), {
      detach: async () => {
        order.push("detached");
        // The old process winds down for minutes; nobody waits on it.
        setTimeout(() => {
          oldProcessGone = true;
        }, 600_000).unref();
        return { stopNow: async () => undefined };
      },
      wake: async () => {
        order.push(`wake while old process gone=${String(oldProcessGone)}`);
        return true;
      },
    });
    expect(await rotateSeatSession("a", ports)).toMatchObject({ ok: true, woke: true });
    expect(order).toEqual(["detached", "wake while old process gone=false"]);
  });

  it("clears the id of a harness that announces its own session", async () => {
    const { acts, ports } = recorder(seat({ harness: "codex" }));
    expect(await rotateSeatSession("a", ports)).toEqual({ ok: true, ended: "s1", woke: true });
    expect(acts).toContain("write a (none)");
  });

  it("reports a seat left stopped when the wake is refused", async () => {
    const { ports } = recorder(seat(), { wake: async () => false });
    expect(await rotateSeatSession("a", ports)).toMatchObject({ ok: true, woke: false });
  });

  it("refuses a missing seat, another installation's seat, and reopens history when the write fails", async () => {
    expect(await rotateSeatSession("a", recorder(undefined).ports)).toMatchObject({ ok: false });
    const remote = recorder(seat({ local: false }));
    expect(await rotateSeatSession("a", remote.ports)).toMatchObject({ ok: false, reason: expect.stringContaining("another installation") });
    expect(remote.acts).toEqual([]);

    const failing = recorder(seat(), { writeSessionId: async () => false });
    expect(await rotateSeatSession("a", failing.ports)).toMatchObject({ ok: false });
    // The seat could not be given a fresh session: the detached process is
    // stopped at once rather than left beside a seat that would resume it.
    expect(failing.acts).toEqual(["detach bind-a", "end a s1", "stop bind-a", "reopen a s1"]);
  });
});
