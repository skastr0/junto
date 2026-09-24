import { batch, observable } from "@legendapp/state";
import type { CanvasPauseState } from "@shared/pause";

/**
 * Factory pause state machine — the single source of truth for the pause
 * switch, shared by the TopBar control and the command bar action.
 *
 * The pause law (@shared/pause) is preserved exactly: the crew is BORN
 * PAUSED and the first play is an explicit operator decision (confirm
 * overlay), never a default. Busy transitions are serialized.
 */
export const factoryPause$ = observable({
  state: null as CanvasPauseState | null,
  busy: false,
  error: "",
  confirmOpen: false,
});

/** Fetch the current pause state for a canvas. Clears the switch (and any
 * open first-play confirm) while the fetch runs so stale state can never
 * fire the toggle. Call on canvas switch. */
export const refreshFactoryPause = async (canvasName: string): Promise<void> => {
  batch(() => {
    factoryPause$.state.set(null);
    factoryPause$.confirmOpen.set(false);
    factoryPause$.error.set("");
  });
  if (!canvasName) return;
  try {
    const state = await window.junto?.factoryPauseState(canvasName);
    if (state) factoryPause$.state.set(state);
  } catch {
    // Unreachable backend: leave the control unrendered rather than lie.
  }
};

/** Apply a pause transition with shared busy, error, and result state. */
export const applyFactoryPause = async (
  canvasName: string,
  paused: boolean,
): Promise<void> => {
  if (!canvasName || factoryPause$.busy.peek()) return;
  factoryPause$.busy.set(true);
  try {
    const result = await window.junto?.factoryPauseSet(
      canvasName,
      { kind: "canvas" },
      paused,
    );
    if (!result) return;
    if (result.ok) {
      factoryPause$.state.set(result.state);
      factoryPause$.confirmOpen.set(false);
      factoryPause$.error.set("");
    } else {
      factoryPause$.error.set(result.error);
    }
  } catch (cause) {
    factoryPause$.error.set(cause instanceof Error ? cause.message : String(cause));
  } finally {
    factoryPause$.busy.set(false);
  }
};

/**
 * Operator toggle: pause is instant; play goes through the first-play
 * confirm gate exactly once per canvas (everPlayed latch), then direct.
 * Falls back to a fresh fetch when the state has not been loaded yet
 * (command bar entry point without a mounted TopBar control).
 */
export const toggleFactoryPause = (canvasName: string): void => {
  if (!canvasName) return;
  const run = (state: CanvasPauseState): void => {
    if (state.playing) {
      void applyFactoryPause(canvasName, true);
      return;
    }
    if (!state.everPlayed) {
      factoryPause$.confirmOpen.set(true);
      return;
    }
    void applyFactoryPause(canvasName, false);
  };
  const current = factoryPause$.state.peek();
  if (current) {
    run(current);
    return;
  }
  void refreshFactoryPause(canvasName).then(() => {
    const state = factoryPause$.state.peek();
    if (state) run(state);
  });
};

/** First-play confirm: operator accepted, play now. */
export const confirmFactoryFirstPlay = (canvasName: string): void => {
  factoryPause$.confirmOpen.set(false);
  void applyFactoryPause(canvasName, false);
};

/** First-play confirm: operator declined. */
export const cancelFactoryFirstPlay = (): void => {
  factoryPause$.confirmOpen.set(false);
};
