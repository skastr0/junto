/**
 * The AI seat verdict, as an input to the delivery gate.
 *
 * `awarenessSeatVerdict` already turns one assessment into a state, a health,
 * and a `holdDelivery` flag. Nothing consumed it: the AI plane could say a seat
 * was blocked on an approval and the drive would type into that dialog anyway.
 * This is the registry between the two — the awareness plane writes the latest
 * verdict per binding, and the drive reads it before typing.
 *
 * Two properties make this safe to wire into a path that touches real seats:
 *
 *   - **It only holds.** `holds` returns true when the AI says the seat is in a
 *     holding state; it can never open a delivery the deterministic plane
 *     closed, and it is combined with `&&`, never instead of, the deterministic
 *     idle check.
 *   - **It fails open.** No verdict, a stale one, an abstention, an unavailable
 *     model, or a seat the sidecar has not observed all mean "no hold": the
 *     product behaves exactly as it did before this existed.
 *
 * The verdict is display-adjacent but this consumer is not: a wrong hold delays
 * a prompt, a wrong release types into a dialog, so the failure direction is
 * chosen deliberately rather than inherited.
 */

import type { AgentSeatState } from "@shared/agent-seat-state";
import type { AwarenessAdvisory } from "./scheduler";
import {
  awarenessSeatVerdict,
  type AwarenessSeatVerdict,
} from "./seat-state";

export type AwarenessSeatHold = {
  /** True when the AI says this seat is in a holding state. Fails open. */
  readonly holds: (bindingId: string) => boolean;
  /** The last verdict for a binding, for tests and diagnostics. */
  readonly verdictFor: (bindingId: string) => AwarenessSeatVerdict | undefined;
  /**
   * Record one advisory. A judgment-free notice (the sidecar is off, nothing
   * was observed, the model failed) clears the seat's verdict rather than
   * leaving a stale hold armed.
   */
  readonly apply: (advisory: AwarenessAdvisory, deterministicState?: AgentSeatState) => void;
  readonly forget: (bindingId: string) => void;
  readonly clear: () => void;
  readonly size: () => number;
};

export const makeAwarenessSeatHold = (): AwarenessSeatHold => {
  const verdicts = new Map<string, AwarenessSeatVerdict>();
  return {
    holds: (bindingId) => verdicts.get(bindingId)?.holdDelivery === true,
    verdictFor: (bindingId) => verdicts.get(bindingId),
    apply: (advisory, deterministicState) => {
      const assessment = advisory.assessment;
      // Only a judged availability carries a verdict. A refusal, a missing key,
      // or the gate-off notice says nothing about the seat, so it clears.
      if (
        assessment === undefined ||
        (advisory.availability !== "current" && advisory.availability !== "abstained")
      ) {
        verdicts.delete(advisory.bindingId);
        return;
      }
      verdicts.set(
        advisory.bindingId,
        awarenessSeatVerdict(assessment, deterministicState),
      );
    },
    forget: (bindingId) => {
      verdicts.delete(bindingId);
    },
    clear: () => {
      verdicts.clear();
    },
    size: () => verdicts.size,
  };
};

/** Process singleton: the awareness plane writes it, the drive reads it. */
export const awarenessSeatHold = makeAwarenessSeatHold();
