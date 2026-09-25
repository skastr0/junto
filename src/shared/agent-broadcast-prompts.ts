/**
 * Pre-configured operator prompts the canvas multi-select menu types into
 * every selected live agent seat. Edit the copy here; the menu, the fan-out
 * and the tests read these constants and nothing else.
 */

export type AgentBroadcastKind = "stop" | "check";

export type AgentBroadcastPrompt = {
  readonly kind: AgentBroadcastKind;
  /** Menu verb. */
  readonly label: string;
  /** Accessible name prefix; the menu appends the seat count. */
  readonly ariaLabel: string;
  /** Text typed into each seat and submitted. */
  readonly text: string;
};

export const AGENT_BROADCAST_PROMPTS: Readonly<Record<AgentBroadcastKind, AgentBroadcastPrompt>> = {
  stop: {
    kind: "stop",
    label: "stop",
    ariaLabel: "Ask selected agents to stop",
    text:
      "The operator asks you to stop. Finish no new steps and start nothing else. " +
      "Reply in a few lines: where you stopped, what is done, what is half done, and what you would do next.",
  },
  check: {
    kind: "check",
    label: "check",
    ariaLabel: "Ask selected agents for a status check",
    text:
      "Quick status check from the operator. Run " +
      "`junto preamble '{\"text\":\"...\"}'` with one short sentence on what you are doing right now, " +
      "then carry on with your work.",
  },
};

export const AGENT_BROADCAST_KINDS: ReadonlyArray<AgentBroadcastKind> = ["stop", "check"];
