import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAUSED_CANVAS, type CanvasPauseState } from "../src/shared/pause";
import {
  applyFactoryPause,
  cancelFactoryFirstPlay,
  confirmFactoryFirstPlay,
  factoryPause$,
  refreshFactoryPause,
  toggleFactoryPause,
} from "../src/renderer/lib/factory-pause";

const playingState: CanvasPauseState = { ...PAUSED_CANVAS, playing: true, everPlayed: true };
const pauseSet = vi.fn(async () => ({ ok: true as const, state: playingState }));

beforeEach(() => {
  pauseSet.mockClear();
  factoryPause$.set({ state: null, busy: false, error: "", confirmOpen: false });
  vi.stubGlobal("window", {
    junto: {
      factoryPauseState: async () => PAUSED_CANVAS,
      factoryPauseSet: pauseSet,
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("factory pause operator controls", () => {
  it("requires explicit confirmation for the first play", async () => {
    await refreshFactoryPause("Workshop");
    expect(factoryPause$.state.peek()).toEqual(PAUSED_CANVAS);

    toggleFactoryPause("Workshop");
    expect(factoryPause$.confirmOpen.peek()).toBe(true);
    expect(pauseSet).not.toHaveBeenCalled();

    confirmFactoryFirstPlay("Workshop");
    await vi.waitFor(() => expect(factoryPause$.state.playing.peek()).toBe(true));
    expect(pauseSet).toHaveBeenCalledExactlyOnceWith("Workshop", { kind: "canvas" }, false);
    expect(factoryPause$.confirmOpen.peek()).toBe(false);
  });

  it("declining first play leaves the factory paused", async () => {
    await refreshFactoryPause("Workshop");
    toggleFactoryPause("Workshop");
    cancelFactoryFirstPlay();

    expect(factoryPause$.confirmOpen.peek()).toBe(false);
    expect(factoryPause$.state.playing.peek()).toBe(false);
    expect(pauseSet).not.toHaveBeenCalled();
  });

  it("pauses an active factory immediately", async () => {
    factoryPause$.state.set(playingState);
    pauseSet.mockResolvedValueOnce({
      ok: true,
      state: { ...playingState, playing: false },
    });

    toggleFactoryPause("Workshop");
    await vi.waitFor(() => expect(factoryPause$.state.playing.peek()).toBe(false));

    expect(pauseSet).toHaveBeenCalledExactlyOnceWith("Workshop", { kind: "canvas" }, true);
    expect(factoryPause$.confirmOpen.peek()).toBe(false);
  });

  it("does not issue a duplicate transition while an IPC request is pending", async () => {
    let finish!: () => void;
    pauseSet.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true, state: playingState });
    }));
    const first = applyFactoryPause("Workshop", false);
    await applyFactoryPause("Workshop", false);
    expect(pauseSet).toHaveBeenCalledOnce();
    expect(factoryPause$.busy.peek()).toBe(true);

    finish();
    await first;
    expect(factoryPause$.busy.peek()).toBe(false);
  });

  it("keeps the previous pause state and exposes a failed transition", async () => {
    factoryPause$.state.set(PAUSED_CANVAS);
    pauseSet.mockRejectedValueOnce(new Error("Station unavailable"));

    await applyFactoryPause("Workshop", false);

    expect(factoryPause$.state.peek()).toEqual(PAUSED_CANVAS);
    expect(factoryPause$.error.peek()).toBe("Station unavailable");
    expect(factoryPause$.busy.peek()).toBe(false);
  });
});
