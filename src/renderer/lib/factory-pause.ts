import { batch, observable } from "@legendapp/state";
import type { CanvasPauseState } from "@shared/pause";
import type { FeatureSet } from "@shared/feature-catalog";
import { BUILD_FEATURES } from "@shared/features";

type CrewCopyFeatures = Pick<FeatureSet, "cron" | "relay" | "tasks">;

const joinSpoken = (items: ReadonlyArray<string>): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")}${items.length > 2 ? "," : ""} and ${items.at(-1)}`;

/** Command bar detail for the pause switch: names only what this build runs. */
export const crewPauseDetail = (
  playing: boolean,
  features: CrewCopyFeatures = BUILD_FEATURES,
): string => {
  const parts = [
    ...(features.cron ? ["cron"] : []),
    ...(features.relay ? ["relay"] : []),
    "agent delivery",
  ];
  return `${playing ? "Stop" : "Start"} ${joinSpoken(parts)} on this canvas`;
};

/** What first play actually does in this build: honest, no softeners. */
export const firstPlayConsequences = (
  features: CrewCopyFeatures = BUILD_FEATURES,
): ReadonlyArray<string> => {
  const schedulers = [
    ...(features.cron ? ["Cron"] : []),
    ...(features.relay ? ["relay"] : []),
  ];
  return [
    ...(schedulers.length > 0
      ? [`${joinSpoken(schedulers)} nodes start firing, and may spend real agent turns.`]
      : []),
    "Agents can act through the Junto CLI.",
    "Queued messages deliver to their targets.",
    ...(features.tasks ? ["Queued tasks are handed to free connected agents."] : []),
  ];
};

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
