/**
 * The window's two offboard calls never throw: a page without a runtime, or a
 * call that fails, comes back as a refused row per seat, or no status. Each is
 * one call to the core's seat-cache-due group, its payload as the group types it.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SeatCacheDueWindow } from "../src/contract/window/seat-cache-due";
import { seatOffboardOpsOf, type SeatOffboardRunInput } from "../src/window/lib/seat-offboard";

const now: SeatOffboardRunInput = { canvasName: "factory", seatIds: ["a", "b"], action: "now" };
const ask: SeatOffboardRunInput = { canvasName: "factory", seatIds: ["a", "b"], action: "ask", mode: "rest" };

const runtimes: Array<ManagedRuntime.ManagedRuntime<SeatCacheDueWindow, never>> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

/** The window's runtime over a stand-in for the group's client. */
const opsOver = (client: Record<string, unknown>) => {
  const runtime = ManagedRuntime.make(Layer.succeed(SeatCacheDueWindow, client as never));
  runtimes.push(runtime);
  return seatOffboardOpsOf(runtime as never);
};

describe("running an offboard", () => {
  it("is one call to the core for the whole selection, answered as the core answers", async () => {
    const answer = {
      results: [
        { seatId: "a", ok: true, action: "now", outcome: "closed", pastWindow: true },
        { seatId: "b", ok: false, code: "working", reason: "This seat is working." },
      ],
      closed: 1,
      asked: 0,
      refused: 1,
    };
    const run = vi.fn(() => Effect.succeed(answer));
    const ops = opsOver({ SeatCacheDueOffboardRun: run });
    expect(await ops.run(now)).toBe(answer);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ input: now });
  });

  it("a call that fails refuses every seat, in order, and does not throw", async () => {
    const ops = opsOver({ SeatCacheDueOffboardRun: () => Effect.die("the link is gone") });
    const result = await ops.run(now);
    expect(result.results.map((row) => [row.seatId, row.ok])).toEqual([["a", false], ["b", false]]);
    expect(result).toMatchObject({ closed: 0, asked: 0, refused: 2 });
    expect(result.results[0]).toMatchObject({ code: "failed", reason: "Junto could not reach its offboard service." });
  });

  it("with no runtime at all, every seat is refused the same way", async () => {
    const ops = seatOffboardOpsOf(undefined);
    expect((await ops.run(now)).refused).toBe(2);
    expect((await ops.run(ask)).refused).toBe(2);
  });
});

describe("asking where seats stand", () => {
  it("returns the core's rows, or nothing when the core cannot be asked", async () => {
    const rows = [{ seatId: "a", now: { allowed: true as const }, idleMinutes: 5, pastWindow: false, preferred: "ask" as const }];
    const status = vi.fn(() => Effect.succeed(rows));
    expect(await opsOver({ SeatCacheDueOffboardStatus: status }).status("factory", ["a"])).toBe(rows);
    expect(status).toHaveBeenCalledWith({ canvasName: "factory", seatIds: ["a"] });
    expect(await opsOver({ SeatCacheDueOffboardStatus: () => Effect.die("gone") }).status("factory", ["a"])).toEqual([]);
    expect(await seatOffboardOpsOf(undefined).status("factory", ["a"])).toEqual([]);
  });
});
