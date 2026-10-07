// @vitest-environment jsdom
/**
 * The offboard panel: what the operator reads and can press, for one seat
 * and for a selection, against a fake of main's two calls.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import {
  OFFBOARD_REFUSAL_REASON,
  summarizeOffboardRun,
  type SeatOffboardRunInput,
  type SeatOffboardRunRow,
  type SeatOffboardStatus,
} from "../src/shared/seat-offboard";
import type { SeatOffboardOps } from "../src/renderer/lib/seat-offboard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { state$ } = await import("../src/renderer/lib/state");
const { SeatOffboardPanel } = await import("../src/renderer/components/nodes/SeatOffboard");

const seat = (id: string, name: string): CanvasNode => ({
  id,
  type: "text",
  text: name,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: { bindingId: `bind-${id}`, harness: "claude", launch: { kind: "harness", argv: ["claude"] } },
  },
});

const status = (seatId: string, over: Partial<SeatOffboardStatus> = {}): SeatOffboardStatus => ({
  seatId,
  now: { allowed: true },
  idleMinutes: 12,
  pastWindow: false,
  preferred: "ask",
  ...over,
});
const working = { allowed: false, code: "working", reason: OFFBOARD_REFUSAL_REASON.working } as const;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  state$.canvasName.set("factory");
  state$.doc.set({ nodes: [seat("a", "Ada"), seat("b", "Bo")], edges: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
};

const fakeOps = (
  statuses: ReadonlyArray<SeatOffboardStatus>,
  rows: (input: SeatOffboardRunInput) => ReadonlyArray<SeatOffboardRunRow> = () => [],
) => {
  const run = vi.fn(async (input: SeatOffboardRunInput) => summarizeOffboardRun(rows(input)));
  const ops: SeatOffboardOps = {
    run,
    status: vi.fn(async (_canvas, seatIds) => statuses.filter((entry) => seatIds.includes(entry.seatId))),
  };
  return { ops, run };
};

const open = async (nodeIds: ReadonlyArray<string>, ops: SeatOffboardOps) => {
  act(() => root.render(<SeatOffboardPanel nodeIds={nodeIds} ops={ops} />));
  await flush();
};
const byId = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const press = async (id: string) => {
  await act(async () => {
    byId<HTMLButtonElement>(id)!.click();
  });
  await flush();
};

describe("one seat", () => {
  it("inside the cache window: asking is marked preferred, and offboard now is still there", async () => {
    await open(["a"], fakeOps([status("a")]).ops);
    expect(host.textContent).toContain("Offboard Ada");
    expect(byId("seat-offboard-idle")?.textContent).toBe("Idle 12m, inside the cache window: a turn is still cheap.");
    const mark = byId("seat-offboard-preferred");
    expect(mark?.parentElement?.contains(byId("seat-offboard-ask-continue"))).toBe(true);
    expect(byId<HTMLButtonElement>("seat-offboard-now")?.disabled).toBe(false);
    expect(byId<HTMLButtonElement>("seat-offboard-ask-rest")?.disabled).toBe(false);
  });

  it("past the cache window: offboard now is the one marked preferred", async () => {
    await open(["a"], fakeOps([status("a", { idleMinutes: 130, pastWindow: true, preferred: "now" })]).ops);
    expect(byId("seat-offboard-idle")?.textContent).toBe("Idle 2h 10m, past the cache window: a turn now is expensive.");
    expect(host.querySelectorAll('[data-testid="seat-offboard-preferred"]')).toHaveLength(1);
    expect(byId("seat-offboard-preferred")?.parentElement?.contains(byId("seat-offboard-now"))).toBe(true);
  });

  it("working: offboard now cannot be pressed and says why; asking still can", async () => {
    await open(["a"], fakeOps([status("a", { now: working, idleMinutes: null })]).ops);
    expect(byId<HTMLButtonElement>("seat-offboard-now")?.disabled).toBe(true);
    expect(byId("seat-offboard-now-block")?.textContent).toBe(OFFBOARD_REFUSAL_REASON.working);
    expect(byId("seat-offboard-idle")).toBeNull();
    expect(byId<HTMLButtonElement>("seat-offboard-ask-continue")?.disabled).toBe(false);
  });

  it("ask to offboard asks to continue; ask, then rest asks to rest", async () => {
    const { ops, run } = fakeOps([status("a")], (input) =>
      input.seatIds.map((seatId) => ({ seatId, ok: true, action: "ask", outcome: "asked", pastWindow: false })),
    );
    await open(["a"], ops);
    await press("seat-offboard-ask-continue");
    expect(run).toHaveBeenLastCalledWith({ canvasName: "factory", seatIds: ["a"], action: "ask", mode: "continue" });
    expect(byId("seat-offboard-status")?.textContent).toBe("Asked to offboard and continue.");
    await press("seat-offboard-ask-rest");
    expect(run).toHaveBeenLastCalledWith({ canvasName: "factory", seatIds: ["a"], action: "ask", mode: "rest" });
    expect(byId("seat-offboard-status")?.textContent).toBe("Asked to offboard and rest.");
    expect(byId("seat-offboard-status")?.getAttribute("data-tone")).toBe("done");
  });

  it("offboard now takes two presses: the first arms it, the second closes the session", async () => {
    const { ops, run } = fakeOps([status("a", { pastWindow: true, preferred: "now", idleMinutes: 90 })], (input) =>
      input.seatIds.map((seatId) => ({ seatId, ok: true, action: "now", outcome: "closed", pastWindow: true })),
    );
    await open(["a"], ops);
    expect(byId("seat-offboard-now")?.textContent).toBe("Offboard now");
    await press("seat-offboard-now");
    expect(run).not.toHaveBeenCalled();
    expect(byId("seat-offboard-now")?.textContent).toBe("Close this session?");
    expect(byId("seat-offboard-now")?.getAttribute("aria-label")).toBe("Confirm: close this session without notes");
    await press("seat-offboard-now");
    expect(byId("seat-offboard-now")?.textContent).toBe("Offboard now");
    expect(run).toHaveBeenCalledWith({ canvasName: "factory", seatIds: ["a"], action: "now" });
    expect(byId("seat-offboard-status")?.textContent).toBe("Session closed. The seat is resting.");
  });

  it("a refusal at the press is shown in main's own words", async () => {
    const { ops } = fakeOps([status("a")], () => [
      { seatId: "a", ok: false, code: "working", reason: OFFBOARD_REFUSAL_REASON.working },
    ]);
    await open(["a"], ops);
    await press("seat-offboard-now");
    await press("seat-offboard-now");
    expect(byId("seat-offboard-status")?.textContent).toBe(`Not closed. ${OFFBOARD_REFUSAL_REASON.working}`);
    expect(byId("seat-offboard-status")?.getAttribute("data-tone")).toBe("refused");
  });
});

describe("a selection", () => {
  const past = { idleMinutes: 130, pastWindow: true, preferred: "now" } as const;

  it("counts the agents, says how many are past the window, and marks no preferred action", async () => {
    await open(["a", "b"], fakeOps([status("a", past), status("b")]).ops);
    expect(host.textContent).toContain("Offboard 2 agents");
    expect(byId("seat-offboard-idle")?.textContent).toBe("1 of 2 are past the cache window.");
    expect(byId("seat-offboard-preferred")).toBeNull();
  });

  it("offboard now goes to every selected seat in one call, and the line counts what happened", async () => {
    const { ops, run } = fakeOps([status("a", past), status("b", { now: working, idleMinutes: null })], () => [
      { seatId: "a", ok: true, action: "now", outcome: "closed", pastWindow: true },
      { seatId: "b", ok: false, code: "working", reason: OFFBOARD_REFUSAL_REASON.working },
    ]);
    await open(["a", "b"], ops);
    // One seat is working, one can be closed: the button stays pressable.
    expect(byId<HTMLButtonElement>("seat-offboard-now")?.disabled).toBe(false);
    await press("seat-offboard-now");
    // The armed button counts what the second press will close: the one idle seat.
    expect(byId("seat-offboard-now")?.textContent).toBe("Close this session?");
    expect(run).not.toHaveBeenCalled();
    await press("seat-offboard-now");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ canvasName: "factory", seatIds: ["a", "b"], action: "now" });
    expect(byId("seat-offboard-status")?.textContent).toBe("1 closed, 1 is working");
    expect(byId("seat-offboard-status")?.getAttribute("data-tone")).toBe("partial");
  });

  it("the armed button names how many sessions it will close, and lets go after three seconds", async () => {
    vi.useFakeTimers();
    try {
      const { ops, run } = fakeOps([status("a", past), status("b", past)]);
      await open(["a", "b"], ops);
      await press("seat-offboard-now");
      expect(byId("seat-offboard-now")?.textContent).toBe("Close 2 sessions?");
      expect(byId("seat-offboard-now")?.getAttribute("data-armed")).toBe("true");
      await act(async () => {
        vi.advanceTimersByTime(3_100);
      });
      expect(byId("seat-offboard-now")?.textContent).toBe("Offboard now");
      expect(byId("seat-offboard-now")?.getAttribute("data-armed")).toBeNull();
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asking disarms an armed offboard now", async () => {
    const { ops, run } = fakeOps([status("a", past), status("b", past)], (input) =>
      input.seatIds.map((seatId) => ({ seatId, ok: true, action: "ask", outcome: "asked", pastWindow: true })),
    );
    await open(["a", "b"], ops);
    await press("seat-offboard-now");
    await press("seat-offboard-ask-continue");
    expect(byId("seat-offboard-now")?.textContent).toBe("Offboard now");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ canvasName: "factory", seatIds: ["a", "b"], action: "ask", mode: "continue" });
  });

  it("offboard now cannot be pressed when no selected seat can be closed", async () => {
    await open(["a", "b"], fakeOps([status("a", { now: working }), status("b", { now: working })]).ops);
    expect(byId<HTMLButtonElement>("seat-offboard-now")?.disabled).toBe(true);
    expect(byId("seat-offboard-now-block")?.textContent).toBe("None of these agents can be closed right now.");
  });

  it("only agents count: a note in the selection is left out", async () => {
    state$.doc.set({
      nodes: [seat("a", "Ada"), { id: "n", type: "text", text: "a note", x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    });
    const { ops, run } = fakeOps([status("a")], (input) =>
      input.seatIds.map((seatId) => ({ seatId, ok: true, action: "ask", outcome: "asked", pastWindow: false })),
    );
    await open(["a", "n"], ops);
    expect(host.textContent).toContain("Offboard Ada");
    await press("seat-offboard-ask-continue");
    expect(run).toHaveBeenCalledWith({ canvasName: "factory", seatIds: ["a"], action: "ask", mode: "continue" });
  });
});
