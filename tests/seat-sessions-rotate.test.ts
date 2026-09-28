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
    stop: async (bindingId) => void acts.push(`stop ${bindingId}`),
    wake: async (_seat, seatId) => (acts.push(`wake ${seatId}`), true),
    mintSessionId: () => "fresh",
    ...overrides,
  };
  return { acts, ports };
};

describe("rotateSeatSession", () => {
  it("ends the session as offboard, pins a fresh id, stops, then wakes", async () => {
    const { acts, ports } = recorder(seat());
    expect(await rotateSeatSession("a", ports)).toEqual({ ok: true, ended: "s1", next: "fresh", woke: true });
    expect(acts).toEqual(["end a s1", "write a fresh", "stop bind-a", "wake a"]);
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
    expect(failing.acts).toEqual(["end a s1", "reopen a s1"]);
  });
});
