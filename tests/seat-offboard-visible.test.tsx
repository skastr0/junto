// @vitest-environment jsdom
/**
 * A failed offboard is visible. The closer publishes "failed" with a reason;
 * the seat card says it on its line, and the offboard controls say it as an
 * alert. Once, it was published and nobody saw it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeatOffboardProgress } from "../src/shared/seat-sessions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bridge = {
  listeners: new Set<(progress: SeatOffboardProgress) => void>(),
  current: [] as SeatOffboardProgress[],
};
vi.mock("../src/renderer/lib/junto-api", () => ({
  getJuntoApi: () => ({
    seatOffboardProgressList: async () => bridge.current,
    onSeatOffboardProgress: (listener: (progress: SeatOffboardProgress) => void) => {
      bridge.listeners.add(listener);
      return () => bridge.listeners.delete(listener);
    },
  }),
}));

const { state$ } = await import("../src/renderer/lib/state");
const { applySeatOffboardProgress, offboardFailureLine, seatOffboard$, subscribeSeatOffboard, useSeatOffboardFailure } = await import(
  "../src/renderer/lib/seat-offboard-state"
);
const { OffboardControls } = await import("../src/renderer/components/sessions/OffboardControls");
const { AgentSeatView } = await import("../src/renderer/components/nodes/AgentSeat");
const { terminalActivity } = await import("../src/renderer/lib/activity");

const progress = (over: Partial<SeatOffboardProgress>): SeatOffboardProgress => ({
  seatId: "seat-1",
  canvasName: "factory",
  mode: "continue",
  stage: "saved",
  at: 1,
  ...over,
});

const failed = progress({ stage: "failed", at: 2, message: "The seat is no longer on its canvas." });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  state$.canvasName.set("factory");
  seatOffboard$.byKey.set({});
  bridge.current = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  // Each test is a window of its own: drop the page-wide subscription.
  subscribeSeatOffboard()();
});

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

describe("a failed offboard, on the seat", () => {
  it("has a line that names the reason, and no line while an offboard is going well", () => {
    expect(offboardFailureLine(failed)).toBe("Offboard did not finish: The seat is no longer on its canvas.");
    expect(offboardFailureLine(progress({ stage: "failed", message: undefined }))).toBe(
      "Offboard did not finish: Junto could not close this session.",
    );
    for (const stage of ["asked", "saved", "resting", "started", "waiting"] as const) {
      expect(offboardFailureLine(progress({ stage }))).toBeUndefined();
    }
    expect(offboardFailureLine(undefined)).toBeUndefined();
  });

  it("the seat card says it in place of its state", () => {
    const html = renderToStaticMarkup(
      <AgentSeatView
        identity="seat-1"
        activity={terminalActivity({ seatState: "idle" })}
        title="planner"
        health={{}}
        signal={{ openCount: 0 }}
        context={offboardFailureLine(failed)}
      />,
    );
    expect(html).toContain("Offboard did not finish: The seat is no longer on its canvas.");
    expect(html).toContain("text-amber");
  });

  function Probe({ seatId }: { readonly seatId: string }) {
    return <span data-testid="line">{useSeatOffboardFailure(seatId) ?? ""}</span>;
  }
  const line = () => host.querySelector('[data-testid="line"]')?.textContent;

  it("reaches the seat when the closer publishes it, and clears when the next offboard starts", async () => {
    act(() => root.render(<Probe seatId="seat-1" />));
    await flush();
    expect(line()).toBe("");
    act(() => {
      for (const listener of bridge.listeners) listener(failed);
    });
    expect(line()).toBe("Offboard did not finish: The seat is no longer on its canvas.");
    // The agent offboards again: the failure is no longer the latest word.
    act(() => {
      for (const listener of bridge.listeners) listener(progress({ stage: "saved", at: 3 }));
    });
    expect(line()).toBe("");
  });

  it("is still there for a window that opens after it happened", async () => {
    bridge.current = [failed];
    act(() => root.render(<Probe seatId="seat-1" />));
    await flush();
    expect(line()).toBe("Offboard did not finish: The seat is no longer on its canvas.");
  });

  it("belongs to its own seat and canvas only", async () => {
    act(() => root.render(<Probe seatId="seat-2" />));
    await flush();
    act(() => applySeatOffboardProgress(failed));
    expect(line()).toBe("");
    act(() => applySeatOffboardProgress({ ...failed, seatId: "seat-2", canvasName: "another" }));
    expect(line()).toBe("");
  });

  it("an older step never replaces a newer one", () => {
    applySeatOffboardProgress(failed);
    applySeatOffboardProgress(progress({ stage: "saved", at: 1 }));
    expect(offboardFailureLine(seatOffboard$.byKey["factory\u0000seat-1"].peek())).toBeDefined();
  });
});

describe("a failed offboard, at the offboard controls", () => {
  it("is an alert with the reason and what to do next", async () => {
    bridge.current = [failed];
    act(() => root.render(<OffboardControls seatId="seat-1" />));
    await flush();
    const alert = host.querySelector('[data-testid="seat-offboard-failed"]');
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe(
      "Offboard did not finish: The seat is no longer on its canvas. The session is still open; ask the agent to offboard again.",
    );
    // The buttons work again: the operator can ask once more.
    expect(host.querySelector<HTMLButtonElement>('[data-testid="seat-offboard-rest"]')?.disabled).toBe(false);
  });

  it("shows no alert while the close is under way", async () => {
    bridge.current = [progress({ stage: "saved" })];
    act(() => root.render(<OffboardControls seatId="seat-1" />));
    await flush();
    expect(host.querySelector('[data-testid="seat-offboard-failed"]')).toBeNull();
  });
});
