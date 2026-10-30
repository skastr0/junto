/**
 * Seat state and the offboard buttons live in the core: its plane publishes each
 * seat's state on the push main forwards to the window, and the buttons are
 * answered by the operation the core installed.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inProcessCore, type CoreRunner } from "../src/main/core-process/client";
import { bindTermIpcPlane, TERM_SEAT_STATE } from "../src/main/core-process/ops/term-ipc";
import "../src/main/core-process/ops/seat-cache-due";
import { subscribe } from "../src/main/core-process/push";
import { seatStateRuntime } from "../src/main/junto/term/agent-state";
import { setOperatorOffboard } from "../src/main/junto/seat-sessions/operator-offboard";

afterEach(() => {
  vi.restoreAllMocks();
  setOperatorOffboard(undefined);
});

describe("the window hears the core's seats", () => {
  it("publishes a seat's state from this machine, until the plane is unbound", () => {
    let emit: (event: never) => void = () => undefined;
    const off = vi.fn();
    vi.spyOn(seatStateRuntime, "subscribe").mockImplementation((listener) => {
      emit = listener as never;
      return off;
    });
    const plane = { router: { setTerminalEnvironment: () => undefined, on: () => undefined, off: () => undefined } };
    const heard: unknown[] = [];
    const stopHearing = subscribe(TERM_SEAT_STATE, (payload) => heard.push(payload));
    const unbind = bindTermIpcPlane(plane as never);
    const event = { bindingId: "seat", state: "working" };
    emit(event as never);
    expect(heard).toEqual([event]);
    unbind();
    expect(off).toHaveBeenCalledTimes(1);
    stopHearing();
  });

  it("answers the offboard buttons from the operation the core installed", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    const core = inProcessCore(runtime as unknown as CoreRunner);
    const status = vi.fn(async () => [{ seatId: "seat", now: { allowed: true } }]);
    const run = vi.fn(async () => ({ results: [] }));
    setOperatorOffboard({ status, run } as never);
    expect(await core.call("seatOffboard.status", { canvasName: "factory", seatIds: ["seat"] }))
      .toEqual([{ seatId: "seat", now: { allowed: true } }]);
    expect(status).toHaveBeenCalledWith("factory", ["seat"]);
    await core.call("seatOffboard.run", { input: { canvasName: "factory", seatIds: ["seat"], action: "now" } });
    expect(run).toHaveBeenCalledWith({ canvasName: "factory", seatIds: ["seat"], action: "now" }, "operator");
    await Effect.runPromise(Effect.promise(() => runtime.dispose()));
  });
});
