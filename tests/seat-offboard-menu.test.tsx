// @vitest-environment jsdom
/**
 * The offboard rows of the canvas right-click menus: a label and one grey
 * line each, the two-press Offboard now, and the result said in the row.
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
const { SeatOffboardMenuRows } = await import("../src/renderer/components/nodes/SeatOffboard");

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
  state$.doc.set({ nodes: [seat("a", "Ada"), seat("b", "Bo"), seat("c", "Cy")], edges: [] });
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
  act(() =>
    root.render(
      <div className="canvas-action-menu" role="toolbar">
        <SeatOffboardMenuRows nodeIds={nodeIds} ops={ops} />
      </div>,
    ),
  );
  await flush();
};
const row = (id: "ask" | "now") => host.querySelector<HTMLButtonElement>(`[data-testid="menu-offboard-${id}"]`)!;
const label = (id: "ask" | "now") => row(id).querySelector("strong")!.textContent;
const detail = (id: "ask" | "now") => row(id).querySelector("small")!.textContent;
const press = async (id: "ask" | "now") => {
  await act(async () => {
    row(id).click();
  });
  await flush();
};

describe("a multi-selection", () => {
  it("two rows in the menu's style: a label and one grey line each", async () => {
    await open(["a", "b", "c"], fakeOps([status("a"), status("b"), status("c", { now: working })]).ops);
    expect(label("ask")).toBe("ask to offboard");
    expect(detail("ask")).toBe("3 agents, continue");
    expect(label("now")).toBe("offboard now");
    expect(detail("now")).toBe("2 of 3 can close now");
    expect(row("now").disabled).toBe(false);
  });

  it("offboard now is greyed with its reason when none can close", async () => {
    await open(["a", "b"], fakeOps([status("a", { now: working }), status("b", { now: working })]).ops);
    expect(row("now").disabled).toBe(true);
    expect(detail("now")).toBe("none can close now: 2 are working");
    expect(row("ask").disabled).toBe(false);
  });

  it("ask to offboard asks every agent to continue, in one call, and says so in the row", async () => {
    const { ops, run } = fakeOps([status("a"), status("b")], (input) =>
      input.seatIds.map((seatId) => ({ seatId, ok: true, action: "ask", outcome: "asked", pastWindow: false })),
    );
    await open(["a", "b"], ops);
    await press("ask");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ canvasName: "factory", seatIds: ["a", "b"], action: "ask", mode: "continue" });
    expect(detail("ask")).toBe("Asked 2 agents to offboard and continue");
    expect(row("ask").getAttribute("data-tone")).toBe("done");
    // The other row keeps its own line.
    expect(detail("now")).toBe("both can close now");
  });

  it("offboard now takes two presses, and the row then counts what happened", async () => {
    const { ops, run } = fakeOps([status("a"), status("b"), status("c", { now: working })], () => [
      { seatId: "a", ok: true, action: "now", outcome: "closed", pastWindow: true },
      { seatId: "b", ok: true, action: "now", outcome: "closed", pastWindow: true },
      { seatId: "c", ok: false, code: "working", reason: OFFBOARD_REFUSAL_REASON.working },
    ]);
    await open(["a", "b", "c"], ops);
    await press("now");
    expect(run).not.toHaveBeenCalled();
    expect(label("now")).toBe("close 2 sessions?");
    expect(detail("now")).toBe("press again to close, no notes");
    expect(row("now").getAttribute("data-armed")).toBe("true");
    await press("now");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ canvasName: "factory", seatIds: ["a", "b", "c"], action: "now" });
    expect(label("now")).toBe("offboard now");
    expect(detail("now")).toBe("2 closed, 1 is working");
    expect(row("now").getAttribute("data-tone")).toBe("partial");
  });

  it("an armed offboard now lets go after three seconds", async () => {
    vi.useFakeTimers();
    try {
      const { ops, run } = fakeOps([status("a"), status("b")]);
      await open(["a", "b"], ops);
      await press("now");
      expect(label("now")).toBe("close 2 sessions?");
      await act(async () => {
        vi.advanceTimersByTime(3_100);
      });
      expect(label("now")).toBe("offboard now");
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("one agent", () => {
  it("says what each row does", async () => {
    await open(["a"], fakeOps([status("a")]).ops);
    expect(detail("ask")).toBe("continue in a fresh session");
    expect(detail("now")).toBe("no notes, the seat rests");
  });

  it("offboard now is greyed with the reason while the agent works", async () => {
    await open(["a"], fakeOps([status("a", { now: working })]).ops);
    expect(row("now").disabled).toBe(true);
    expect(detail("now")).toBe("this agent is working");
  });

  it("two presses close the session", async () => {
    const { ops, run } = fakeOps([status("a")], () => [
      { seatId: "a", ok: true, action: "now", outcome: "closed", pastWindow: false },
    ]);
    await open(["a"], ops);
    await press("now");
    expect(label("now")).toBe("close this session?");
    await press("now");
    expect(run).toHaveBeenCalledWith({ canvasName: "factory", seatIds: ["a"], action: "now" });
    expect(detail("now")).toBe("Session closed. The seat is resting.");
  });
});

describe("a selection with no agent", () => {
  it("renders no row", async () => {
    state$.doc.set({ nodes: [{ id: "n", type: "text", text: "note", x: 0, y: 0, width: 10, height: 10 }], edges: [] });
    await open(["n"], fakeOps([]).ops);
    expect(host.querySelector("button")).toBeNull();
  });
});
