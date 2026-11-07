/**
 * Seat state and the offboard buttons live in the core: its plane publishes each
 * seat's state on the push main forwards to the window, and the buttons are
 * answered by the operation the core installed.
 */
import { Effect } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindTermIpcPlane } from "../src/core/ops/term-ipc";
import { TERM_SEAT_STATE } from "../src/contract/core/channels";
import { SeatCacheDueRpcs } from "../src/contract/core/seat-cache-due";
import { SeatCacheDueHandlers } from "../src/core/ops/seat-cache-due";
import { subscribe } from "../src/app/core-process/main-side/core-pushes";
import { seatStateRuntime } from "../src/core/term/agent-state";
import { setOperatorOffboard } from "../src/core/seat-sessions/operator-offboard";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";

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
    // A whole event: main decodes each push with its Schema, and refuses a partial one.
    const event: AgentSeatStateEvent = { bindingId: "seat", epoch: "e1", state: "working", reason: "typing", confidence: "high", at: 1 };
    emit(event as never);
    expect(heard).toEqual([event]);
    unbind();
    expect(off).toHaveBeenCalledTimes(1);
    stopHearing();
  });

  it("answers the offboard buttons from the operation the core installed", async () => {
    const status = vi.fn(async () => [{ seatId: "seat", now: { allowed: true } }]);
    const run = vi.fn(async () => ({ results: [] }));
    setOperatorOffboard({ status, run } as never);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(SeatCacheDueRpcs);
          expect(yield* client.SeatCacheDueOffboardStatus({ canvasName: "factory", seatIds: ["seat"] }))
            .toEqual([{ seatId: "seat", now: { allowed: true } }]);
          expect(status).toHaveBeenCalledWith("factory", ["seat"]);
          yield* client.SeatCacheDueOffboardRun({ input: { canvasName: "factory", seatIds: ["seat"], action: "now" } });
          expect(run).toHaveBeenCalledWith({ canvasName: "factory", seatIds: ["seat"], action: "now" }, "operator");
        }),
      ).pipe(Effect.provide(SeatCacheDueHandlers)),
    );
  });
});
