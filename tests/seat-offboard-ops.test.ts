/**
 * The renderer's two offboard calls never throw: a main that is not there,
 * or a call that fails, comes back as a refused row per seat.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SeatOffboardRunInput, SeatOffboardStatus } from "../src/shared/seat-offboard";

let bridge: Record<string, unknown> | undefined;
vi.mock("../src/renderer/lib/junto-api", () => ({ getJuntoApi: () => bridge }));

const { seatOffboardOps } = await import("../src/renderer/lib/seat-offboard");

const now: SeatOffboardRunInput = { canvasName: "factory", seatIds: ["a", "b"], action: "now" };
const ask: SeatOffboardRunInput = { canvasName: "factory", seatIds: ["a", "b"], action: "ask", mode: "rest" };

beforeEach(() => {
  bridge = undefined;
});

describe("running an offboard", () => {
  it("is one call to main for the whole selection, answered as main answers", async () => {
    const answer = {
      results: [
        { seatId: "a", ok: true, action: "now", outcome: "closed", pastWindow: true },
        { seatId: "b", ok: false, code: "working", reason: "This seat is working." },
      ],
      closed: 1,
      asked: 0,
      refused: 1,
    };
    const seatOffboardRun = vi.fn(async () => answer);
    bridge = { seatOffboardRun };
    expect(await seatOffboardOps.run(now)).toBe(answer);
    expect(seatOffboardRun).toHaveBeenCalledTimes(1);
    expect(seatOffboardRun).toHaveBeenCalledWith(now);
  });

  it("a call that fails refuses every seat, in order, and does not throw", async () => {
    bridge = { seatOffboardRun: async () => Promise.reject(new Error("ipc timeout")) };
    const result = await seatOffboardOps.run(now);
    expect(result.results.map((row) => [row.seatId, row.ok])).toEqual([["a", false], ["b", false]]);
    expect(result).toMatchObject({ closed: 0, asked: 0, refused: 2 });
    expect(result.results[0]).toMatchObject({ code: "failed", reason: "Junto could not reach its offboard service." });
  });

  it("with no main at all, every seat is refused the same way", async () => {
    expect((await seatOffboardOps.run(now)).refused).toBe(2);
    expect((await seatOffboardOps.run(ask)).refused).toBe(2);
  });

  it("a main without the list call still takes an ask, seat by seat, in the asked mode", async () => {
    const seatOffboardAsk = vi.fn(async (_canvas: string, seatId: string) =>
      seatId === "a" ? { ok: true as const } : { ok: false as const, message: "This seat runs on another installation." },
    );
    bridge = { seatOffboardAsk };
    const result = await seatOffboardOps.run(ask);
    expect(seatOffboardAsk.mock.calls).toEqual([["factory", "a", "rest"], ["factory", "b", "rest"]]);
    expect(result).toMatchObject({ asked: 1, refused: 1, closed: 0 });
    expect(result.results[1]).toMatchObject({ seatId: "b", ok: false, code: "undelivered", reason: "This seat runs on another installation." });
    // Offboard now has no such fallback: it is refused, never turned into an ask.
    expect((await seatOffboardOps.run(now)).refused).toBe(2);
    expect(seatOffboardAsk).toHaveBeenCalledTimes(2);
  });
});

describe("asking where seats stand", () => {
  it("returns main's rows, or nothing when main cannot be asked", async () => {
    const rows: SeatOffboardStatus[] = [
      { seatId: "a", now: { allowed: true }, idleMinutes: 5, pastWindow: false, preferred: "ask" },
    ];
    bridge = { seatOffboardStatus: async () => rows };
    expect(await seatOffboardOps.status("factory", ["a"])).toBe(rows);
    bridge = { seatOffboardStatus: async () => Promise.reject(new Error("gone")) };
    expect(await seatOffboardOps.status("factory", ["a"])).toEqual([]);
    bridge = undefined;
    expect(await seatOffboardOps.status("factory", ["a"])).toEqual([]);
  });
});
