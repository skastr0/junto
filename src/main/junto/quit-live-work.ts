// Quit affordance: detect live work and build the honest confirm prompt.
// Pure + injectable — main process supplies terminal counts.
// Region Pulse arming is retired and is not a quit blocker. Kernel timers
// alone do not count as live work without the retired arming product.

export interface LiveWorkSnapshot {
  /** Local native sessions, attached or detached (all stop on quit). */
  readonly localTerminalSessionCount: number;
}

export interface LiveWorkInputs {
  readonly localTerminalSessionCount: number;
}

export const assessLiveWork = (input: LiveWorkInputs): LiveWorkSnapshot => ({
  localTerminalSessionCount: Math.max(0, input.localTerminalSessionCount | 0),
});

export const hasLiveWork = (snapshot: LiveWorkSnapshot): boolean =>
  snapshot.localTerminalSessionCount > 0;

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

/** Honest copy: what pauses vs what stops. */
export const buildQuitConfirmPrompt = (snapshot: LiveWorkSnapshot): QuitConfirmPrompt => {
  const lines: string[] = [];
  if (snapshot.localTerminalSessionCount > 0) {
    lines.push(
      `${snapshot.localTerminalSessionCount} local terminal session${snapshot.localTerminalSessionCount === 1 ? "" : "s"}`,
    );
  }

  const inventory = lines.length > 0 ? lines.map((line) => `• ${line}`).join("\n") : "• live work";

  return {
    type: "warning",
    title: "Quit Junto?",
    message: "Live work is present. Quit pauses the factory for this machine.",
    detail:
      `${inventory}\n\n` +
      "Pauses on quit:\n" +
      "• Watchers and kernel timers\n" +
      "• Local control sockets\n\n" +
      "Stops on quit:\n" +
      "• Local terminal sessions (including detached sessions)",
    buttons: ["Cancel", "Quit"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
};
