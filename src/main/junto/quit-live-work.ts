// Quit affordance: detect live work and build the honest confirm prompt.
// Pure + injectable — main process supplies terminal counts.
// Region Pulse arming is retired and is not a quit blocker. Kernel timers
// alone do not count as live work without the retired arming product.

/**
 * Live work, as the quit confirm reads it.
 *
 * `countUnknown` is the third answer: the process that owns the terminals did
 * not say. It is not zero. A quit that assumed zero would drop running seats
 * without a word.
 */
export interface LiveWorkSnapshot {
  /** Local native sessions, attached or detached (all stop on quit). */
  readonly localTerminalSessionCount: number;
  /** The terminal owner could not be asked: treat as live work, and say so. */
  readonly countUnknown: boolean;
}

export interface LiveWorkInputs {
  readonly localTerminalSessionCount: number | "unknown";
}

export const assessLiveWork = (input: LiveWorkInputs): LiveWorkSnapshot => ({
  localTerminalSessionCount:
    input.localTerminalSessionCount === "unknown" ? 0 : Math.max(0, input.localTerminalSessionCount | 0),
  countUnknown: input.localTerminalSessionCount === "unknown",
});

export const hasLiveWork = (snapshot: LiveWorkSnapshot): boolean =>
  snapshot.countUnknown || snapshot.localTerminalSessionCount > 0;

/** One terminal session, as the quit check needs it: only the status matters. */
export interface LiveSessionLike {
  readonly status: string;
}

/**
 * Ask whoever owns the terminals what is running. The caller passes the ask
 * (main: `core.call("term.list", {})`), so both answers are testable here: the
 * count, and the unknown that must warn rather than assume zero.
 */
export const probeLiveWork = async (
  ask: () => Promise<ReadonlyArray<LiveSessionLike>>,
): Promise<LiveWorkSnapshot> => {
  let sessions: ReadonlyArray<LiveSessionLike>;
  try {
    sessions = await ask();
  } catch (cause) {
    console.error("[quit] the terminal owner did not say what is running; treating the count as unknown", cause);
    return assessLiveWork({ localTerminalSessionCount: "unknown" });
  }
  const running = sessions.filter((session) => session.status === "running" || session.status === "starting");
  return assessLiveWork({ localTerminalSessionCount: running.length });
};

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
  if (snapshot.countUnknown) {
    lines.push("Local terminal sessions (the core did not answer how many)");
  } else if (snapshot.localTerminalSessionCount > 0) {
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
      "• Automations and schedules on this machine\n" +
      "• Local control sockets\n\n" +
      "Stops on quit:\n" +
      "• Local terminal sessions (including detached sessions)",
    buttons: ["Cancel", "Quit"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
};
