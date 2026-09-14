/**
 * Composer verdict — the screen answers "may the factory type into this
 * seat's input box?".
 *
 * The terminal is rendered inside the app, so every harness's composer is on
 * screen by definition. Each rule pack declares probes for its own composer
 * chrome (empty glyph, placeholder hint, drafted text); the verdict is read
 * from the live grid, never inferred from an input-byte tally. A pack whose
 * probes cannot prove an empty composer yields null and factory typing
 * refuses — an unreadable composer is never a writable one.
 *
 * Probes are evaluated in declared order; the first match wins. This runs on
 * every observer snapshot and at the paste gate, independent of which rule
 * wins the seat-STATE competition — a structured hook feed owning the state
 * does not blind the composer question.
 */

import { matcherMatches, regionLines, regionText } from "./match";
import { rulePackFor } from "./rules";
import { isHarnessId } from "../../../../shared/managed-terminal-templates";
import type { ObserverGridSnapshot } from "../observer/types";
import type { ComposerVerdict, SeatRulePack } from "./types";

/** Evaluate one snapshot against a pack's composer probes. */
export const composerVerdictFor = (
  snapshot: ObserverGridSnapshot,
  pack: SeatRulePack,
): ComposerVerdict => {
  for (const probe of pack.composer ?? []) {
    const lines = regionLines(snapshot, probe.region, probe.regionN);
    if (matcherMatches(probe.matchers, regionText(lines), lines)) {
      return probe.verdict;
    }
  }
  return null;
};

/** Harness-string convenience: unknown harness has no probes → null. */
export const composerVerdictForHarness = (
  snapshot: ObserverGridSnapshot,
  harness: string,
): ComposerVerdict => {
  if (!isHarnessId(harness)) return null;
  return composerVerdictFor(snapshot, rulePackFor(harness));
};

/**
 * Amp / omp have no grounded composer probes, so the
 * live verdict is always null and the drive refuses (`composer-unreadable`).
 * Tier B firstTyped is the only doctrine path on those seats — admit a
 * one-shot empty while the arm is live. Packs that already declare probes
 * stay fail-closed: null still means unreadable.
 */
export const admitUngroundedFirstTypedComposer = (
  verdict: ComposerVerdict,
  pack: SeatRulePack | undefined,
  firstTypedArmed: boolean,
): ComposerVerdict => {
  if (verdict !== null) return verdict;
  if (!firstTypedArmed || pack === undefined) return null;
  if ((pack.composer?.length ?? 0) > 0) return null;
  return "empty";
};
