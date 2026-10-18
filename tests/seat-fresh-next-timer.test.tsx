// @vitest-environment jsdom
/**
 * useSeatFreshNext asks main again at the moment main said the session goes
 * cold, with nothing else moving: a seat held only by a recent key, or one
 * still inside its cache window, turns to fresh next on its own.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeatNextTurn } from "../src/shared/seat-next-launch";
import { seatNextTurn$, useSeatFreshNext } from "../src/renderer/lib/seat-next-launch";

const NOW = 1_792_000_000_000;
const COLD_AT = NOW + 30_000;

let shown: boolean | undefined;
function Probe({ still }: { readonly still: boolean }) {
  shown = useSeatFreshNext("factory", "lead", still, "moved");
  return null;
}

describe("useSeatFreshNext", () => {
  let root: Root;
  let host: HTMLElement;
  const ask = vi.fn<() => Promise<{ hasSession: boolean; next: "resume"; nextTurn: SeatNextTurn }>>();

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // Main: warm until COLD_AT, cold after.
    ask.mockImplementation(async () => ({
      hasSession: true,
      next: "resume",
      nextTurn: Date.now() < COLD_AT ? { fresh: false, freshAt: COLD_AT } : { fresh: true },
    }));
    (window as unknown as { junto: unknown }).junto = { modelSeatLaunchState: ask };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (window as unknown as { junto?: unknown }).junto;
    seatNextTurn$.set({});
    ask.mockReset();
    shown = undefined;
    vi.useRealTimers();
  });

  it("turns to fresh next at the moment main gave, with nothing moving", async () => {
    await act(async () => root.render(<Probe still />));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(shown).toBe(false);

    // A moment before: nothing is asked and nothing shows.
    await act(async () => vi.advanceTimersByTimeAsync(29_000));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(shown).toBe(false);

    // Just past it (the hook allows a second): asked again, and fresh.
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(ask).toHaveBeenCalledTimes(2);
    expect(shown).toBe(true);
  });

  it("a seat that starts a turn before that moment is not asked at it", async () => {
    await act(async () => root.render(<Probe still />));
    await act(async () => root.render(<Probe still={false} />));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(shown).toBe(false);
  });
});
