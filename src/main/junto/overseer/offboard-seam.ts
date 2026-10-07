import type { OverseerOffboardAction } from "@shared/overseer-control";
import type { OffboardMode } from "@shared/seat-sessions";

/**
 * The seam to the operator's offboard entry point in main.
 *
 * The overseer's `agent.offboard*` operations do what the operator's buttons
 * do, through the same entry point: main decides whether a seat can be ended
 * now, main words the ask, main holds the automatic rules. Nothing on this
 * side tests idleness, composes a prompt, or retries.
 *
 * STAND-IN: the entry point has not been published. Until it is this is
 * undefined and every `agent.offboard*` operation answers Unsupported. The
 * swap is this one binding.
 */
export type OverseerOffboardSeatResult =
  | { readonly ok: true; readonly title?: string; readonly outcome: string }
  /** `reason` is main's plain sentence, shown as it is. */
  | { readonly ok: false; readonly title?: string; readonly reason: string };

export type OverseerOffboardRule = {
  readonly enabled: boolean;
  readonly minutes: number;
};

export type OverseerOffboardRules = {
  readonly auto: OverseerOffboardRule;
  readonly nudge: OverseerOffboardRule;
};

export type OverseerOffboardRulesChange = {
  readonly auto?: Partial<OverseerOffboardRule>;
  readonly nudge?: Partial<OverseerOffboardRule>;
};

export type OverseerOffboard = {
  /** One seat. An unknown node, or one that is not a seat, is a refusal. */
  readonly seat: (input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly action: OverseerOffboardAction;
    /** Meaningful for `ask` only. */
    readonly mode: OffboardMode;
  }) => Promise<OverseerOffboardSeatResult>;
  readonly rules: () => Promise<OverseerOffboardRules>;
  /** Returns the rules after the change. */
  readonly configure: (
    change: OverseerOffboardRulesChange,
  ) => Promise<OverseerOffboardRules>;
};

export const overseerOffboard: OverseerOffboard | undefined = undefined;
