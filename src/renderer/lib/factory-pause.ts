import { batch, observable } from "@legendapp/state";
import type { CanvasPauseState } from "@shared/pause";

/**
 * Factory pause state machine — the single source of truth for the pause
 * switch, shared by the TopBar control and the command bar action.
 *
 * The pause law (@shared/pause) is preserved exactly: the factory is BORN
 * PAUSED and the first play is an explicit operator decision (confirm
 * overlay), never a default. Busy and license-maintenance guards apply to
 * every entry point.
 */
export const factoryPause$ = observable({
  state: null as CanvasPauseState | null,
  busy: false,
  error: "",
  licenseMaintenance: false,
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
    const state = await window.vellumCommand?.factoryPauseState(canvasName);
    if (state) factoryPause$.state.set(state);
  } catch {
    // Unreachable backend: leave the control unrendered rather than lie.
  }
};

/** License gate subscription. Returns the unsubscribe fn (TopBar owns the
 * lifetime once per app session). */
export const refreshFactoryLicense = (): (() => void) | undefined => {
  const syncLicense = (status: { access: string; canPlayFactory?: boolean }) => {
    factoryPause$.licenseMaintenance.set(
      status.access === "maintenance" || status.canPlayFactory === false,
    );
  };
  void window.vellumCommand?.licenseStatus?.().then(syncLicense).catch(() => undefined);
  return window.vellumCommand?.onLicenseChanged?.(syncLicense);
};

/** Apply a pause transition. Busy + license guards; shared error/state. */
export const applyFactoryPause = async (
  canvasName: string,
  paused: boolean,
): Promise<void> => {
  if (!canvasName || factoryPause$.busy.peek() || factoryPause$.licenseMaintenance.peek()) return;
  factoryPause$.busy.set(true);
  try {
    const result = await window.vellumCommand?.factoryPauseSet(
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
  if (!canvasName || factoryPause$.licenseMaintenance.peek()) return;
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
