// Quit affordance: detect live work and build the honest confirm prompt.
// Pure + injectable — main process supplies armed/timers/herdr counts.
// Product lock: herdr panes/sessions are NEVER killed; the dialog must say so.

export interface LiveWorkSnapshot {
  /** Armed canvas::region keys (true values only). */
  readonly armedRegionCount: number;
  /**
   * Scheduled kernel timers on a canvas that still has ≥1 armed region.
   * Disarmed-only timer schedules are not "live work" (they only dry-log).
   */
  readonly scheduledTimerCount: number;
  /** Attached herdr control streams in this process (detach-on-quit, never kill). */
  readonly attachedHerdrStreamCount: number;
}

export interface LiveWorkInputs {
  /** armed map entries: [canvas::regionId, armed] */
  readonly armed: Iterable<readonly [string, boolean]>;
  /** nextFire keys: canvas::nodeId */
  readonly nextFireKeys: Iterable<string>;
  readonly attachedHerdrStreamCount: number;
}

export const canvasKeyOf = (compound: string): string => {
  const sep = compound.indexOf("::");
  return sep === -1 ? compound : compound.slice(0, sep);
};

export const countArmedRegions = (
  armed: Iterable<readonly [string, boolean]>,
): number => {
  let n = 0;
  for (const [, value] of armed) {
    if (value) n += 1;
  }
  return n;
};

/** Canvases that still have at least one armed region. */
export const armedCanvasNames = (
  armed: Iterable<readonly [string, boolean]>,
): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const [key, value] of armed) {
    if (value) out.add(canvasKeyOf(key));
  }
  return out;
};

export const countLiveTimers = (
  nextFireKeys: Iterable<string>,
  armedCanvases: ReadonlySet<string>,
): number => {
  if (armedCanvases.size === 0) return 0;
  let n = 0;
  for (const key of nextFireKeys) {
    if (armedCanvases.has(canvasKeyOf(key))) n += 1;
  }
  return n;
};

export const assessLiveWork = (input: LiveWorkInputs): LiveWorkSnapshot => {
  const armedRegionCount = countArmedRegions(input.armed);
  const canvases = armedCanvasNames(input.armed);
  return {
    armedRegionCount,
    scheduledTimerCount: countLiveTimers(input.nextFireKeys, canvases),
    attachedHerdrStreamCount: Math.max(0, input.attachedHerdrStreamCount | 0),
  };
};

export const hasLiveWork = (snapshot: LiveWorkSnapshot): boolean =>
  snapshot.armedRegionCount > 0 ||
  snapshot.scheduledTimerCount > 0 ||
  snapshot.attachedHerdrStreamCount > 0;

export interface QuitConfirmPrompt {
  readonly type: "warning";
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly ["Cancel", "Quit"];
  readonly defaultId: 0;
  readonly cancelId: 0;
  readonly noLink: true;
}

/** Button index that confirms quit (matches buttons: Cancel, Quit). */
export const QUIT_CONFIRM_ACCEPT_INDEX = 1 as const;

/**
 * Honest copy: what pauses vs what survives. Herdr is never killed — detach only.
 */
export const buildQuitConfirmPrompt = (snapshot: LiveWorkSnapshot): QuitConfirmPrompt => {
  const lines: string[] = [];
  if (snapshot.armedRegionCount > 0) {
    lines.push(
      `${snapshot.armedRegionCount} armed region${snapshot.armedRegionCount === 1 ? "" : "s"} (watchers + pulses)`,
    );
  }
  if (snapshot.scheduledTimerCount > 0) {
    lines.push(
      `${snapshot.scheduledTimerCount} running timer${snapshot.scheduledTimerCount === 1 ? "" : "s"}`,
    );
  }
  if (snapshot.attachedHerdrStreamCount > 0) {
    lines.push(
      `${snapshot.attachedHerdrStreamCount} attached herdr surface${snapshot.attachedHerdrStreamCount === 1 ? "" : "s"}`,
    );
  }

  const inventory = lines.length > 0 ? lines.map((line) => `• ${line}`).join("\n") : "• live work";

  return {
    type: "warning",
    title: "Quit Vellum?",
    message: "Live work is present. Quit pauses the factory for this machine.",
    detail:
      `${inventory}\n\n` +
      "Pauses on quit:\n" +
      "• Watchers, pulses, and kernel timers\n" +
      "• Local control sockets\n\n" +
      "Survives quit:\n" +
      "• Herdr panes and sessions detach and keep running on the host — they are never killed.",
    buttons: ["Cancel", "Quit"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
};
