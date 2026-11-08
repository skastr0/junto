import { batch } from "@legendapp/state";
import { patchSettings } from "./settings-state";
import { state$ } from "./state";

// First-run introduction: a short tour shown once, then only on request.
// The seen flag lives in the durable settings row (advanced.onboardingSeen),
// never in browser storage, so it survives a renderer reset and follows the
// installation's data store.

export interface IntroVisibilityInput {
  /** The durable settings row has hydrated; before that, `seen` is a default. */
  readonly settingsReady: boolean;
  readonly seen: boolean | undefined;
  /** Reopened from the help map or Settings. */
  readonly requested: boolean;
  /** Finished or skipped earlier in this session. */
  readonly dismissed: boolean;
}

export const introVisible = (input: IntroVisibilityInput): boolean =>
  input.requested ||
  (input.settingsReady && input.seen !== true && !input.dismissed);

/** Reopen the introduction from the first slide. */
export const openIntro = (): void => {
  state$.introOpen.set(true);
};

/**
 * Finish or skip. Closes at once; the durable write follows. A failed write
 * leaves the flag unset, so the next launch shows the tour again, but this
 * session never reopens it on its own.
 */
export const finishIntro = async (): Promise<void> => {
  batch(() => {
    state$.introOpen.set(false);
    state$.introDismissed.set(true);
  });
  if (state$.settings.peek().advanced.onboardingSeen === true) return;
  await patchSettings({ advanced: { onboardingSeen: true } });
};
