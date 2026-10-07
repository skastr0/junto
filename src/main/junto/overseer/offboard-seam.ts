import type {
  OffboardBy,
  OffboardRules,
  OffboardRulesPatch,
  SeatOffboardRunInput,
  SeatOffboardRunResult,
  SeatOffboardStatus,
} from "@shared/seat-offboard";

/**
 * The seam to the operator's offboard entry point in main.
 *
 * The overseer's `agent.offboard*` operations do what the operator's buttons
 * do, through the same entry point: main decides whether a seat can be ended
 * now, main words the ask, main holds the rules. Nothing on this side tests
 * idleness, composes a prompt, builds a row, or retries.
 *
 * STAND-IN: the entry point has not landed. The four members are
 * `runSeatOffboard`, `seatOffboardStatus`, `readOffboardRules` and
 * `patchOffboardRules` in `main/junto/seat-sessions/operator-offboard.ts`.
 * Until they land this is undefined and every `agent.offboard*` operation
 * answers Unsupported. The swap is this one binding.
 */
export type OverseerOffboardRulesPatched =
  | { readonly ok: true; readonly rules: OffboardRules }
  | { readonly ok: false; readonly message: string };

export type OverseerOffboard = {
  /** One call for the whole list. Rows come back in the order asked. */
  readonly run: (
    input: SeatOffboardRunInput,
    by: OffboardBy,
  ) => Promise<SeatOffboardRunResult>;
  readonly status: (
    canvasName: string,
    seatIds: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<SeatOffboardStatus>>;
  readonly readRules: () => OffboardRules | Promise<OffboardRules>;
  /** Applies, checks and saves. A refused change says why in plain words. */
  readonly patchRules: (patch: OffboardRulesPatch) => OverseerOffboardRulesPatched |
    Promise<OverseerOffboardRulesPatched>;
};

export const overseerOffboard: OverseerOffboard | undefined = undefined;
