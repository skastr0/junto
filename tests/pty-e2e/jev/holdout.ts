/**
 * Held-out split.
 *
 * The parent's paid runs are the thing that must not be tuned against the
 * evaluation. Its `CURATED` list (recovered from the parent thread) is the
 * tune set; everything else in the committed corpus is reserved, and two tiers
 * are called out explicitly so a reviewer can see what a score is a score OF:
 *
 *   Tier 1 — WHOLE HARNESS `pi`. The parent's only pi entry
 *     (`pi/working-turn`) is a declared skip with no bytes, so no real pi
 *     capture was ever sent. Every pi capture is therefore unseen at the
 *     harness level: a score on it is a generalisation score, not a fit.
 *   Tier 2 — WHOLE CAPTURES that carry the label classes the tune set cannot
 *     test: a real permission dialog, a trust dialog, and the login/credential
 *     failures that ground `access_problem` and `execution_error`.
 *
 * `assertHoldoutDisjoint()` is called from the suite, so a future edit that
 * quietly adds a holdout capture to the tune set fails red.
 */

import { existsSync } from "node:fs";
import { capturePath } from "../runner";

/** Exactly the parent's `CURATED` entries that resolved to real bytes. */
export const PAID_CAPTURES = [
  "amp/working-turn",
  "claude/working-turn",
  "codex/startup-idle",
  "codex/working-turn",
  "devin/working-turn",
  "grok/working-turn",
  "hermes/startup-idle",
  "kimi/startup-idle",
  "muse/working-turn",
  "omp/working-turn",
] as const;

/** `CURATED` entries that resolved to a declared skip — never paid. */
export const DECLARED_SKIPS = [
  "claude/permission-returns-idle",
  "pi/working-turn",
] as const;

/** Tier 1: whole-harness holdout. */
export const HOLDOUT_HARNESSES = ["pi"] as const;

/** Tier 2: whole-capture holdout, chosen for label-class coverage. */
export const HOLDOUT_CAPTURES = [
  "grok/permission-returns-idle",
  "devin/startup-trust",
  "devin/mail-notice",
  "claude/mail-notice",
  "kimi/type-echo",
  "hermes/type-echo",
  "codex/mail-notice",
  "muse/startup-idle",
] as const;

/** Every capture the parent's paid runs never sent. */
export const RESERVED_CAPTURES: readonly string[] = [
  "amp/startup-idle",
  "amp/type-echo",
  "amp/paste-chip",
  "claude/startup-idle",
  "claude/type-echo",
  "claude/paste-chip",
  "claude/mail-notice",
  "codex/type-echo",
  "codex/paste-chip",
  "codex/mail-notice",
  "devin/startup-idle",
  "devin/type-echo",
  "devin/paste-chip",
  "devin/startup-trust",
  "devin/mail-notice",
  "grok/startup-idle",
  "grok/type-echo",
  "grok/paste-chip",
  "grok/permission-returns-idle",
  "hermes/type-echo",
  "hermes/paste-chip",
  "kimi/type-echo",
  "muse/startup-idle",
  "muse/type-echo",
  "muse/paste-chip",
  "omp/startup-idle",
  "omp/type-echo",
  "omp/paste-chip",
  "pi/startup-idle",
  "pi/type-echo",
] as const;

export type Split = "tune" | "holdout" | "holdout-tier1" | "holdout-tier2" | "all" | "reserved";

export const SPLITS: readonly Split[] = [
  "tune",
  "holdout",
  "holdout-tier1",
  "holdout-tier2",
  "reserved",
  "all",
];

export const capturesForSplit = (split: Split, allCaptures: readonly string[]): readonly string[] => {
  switch (split) {
    case "tune":
      return allCaptures.filter((key) => (PAID_CAPTURES as readonly string[]).includes(key));
    case "holdout":
      return allCaptures.filter(
        (key) =>
          (HOLDOUT_CAPTURES as readonly string[]).includes(key) ||
          HOLDOUT_HARNESSES.some((harness) => key.startsWith(`${harness}/`)),
      );
    case "holdout-tier1":
      return allCaptures.filter((key) => HOLDOUT_HARNESSES.some((harness) => key.startsWith(`${harness}/`)));
    case "holdout-tier2":
      return allCaptures.filter((key) => (HOLDOUT_CAPTURES as readonly string[]).includes(key));
    case "reserved":
      return allCaptures.filter((key) => (RESERVED_CAPTURES as readonly string[]).includes(key));
    case "all":
      return [...allCaptures];
  }
};

/** `harness/scenario` for every committed capture file. */
export const allCapturesOf = (harnesses: readonly string[], scenariosOf: (harness: string) => readonly string[]): readonly string[] =>
  harnesses.flatMap((harness) => scenariosOf(harness).map((scenario) => `${harness}/${scenario}`));

export const assertHoldoutDisjoint = (): void => {
  const paid = new Set<string>(PAID_CAPTURES);
  const problems: string[] = [];
  for (const key of [...HOLDOUT_CAPTURES, ...RESERVED_CAPTURES]) {
    if (paid.has(key)) problems.push(`${key} is both held out and in the paid tune set`);
    const [harness, scenario] = key.split("/");
    if (harness === undefined || scenario === undefined) {
      problems.push(`${key} is not a harness/scenario key`);
      continue;
    }
    if (!existsSync(capturePath(harness, scenario))) {
      problems.push(`${key} is held out but has no committed capture`);
    }
  }
  for (const harness of HOLDOUT_HARNESSES) {
    if (paid.has(`${harness}/working-turn`)) problems.push(`${harness} holdout harness is in the paid set`);
  }
  const reserved = new Set<string>(RESERVED_CAPTURES);
  const declared = new Set<string>(DECLARED_SKIPS);
  for (const key of paid) {
    if (reserved.has(key)) problems.push(`${key} is in the paid set and the reserved set`);
    if (declared.has(key)) problems.push(`${key} is declared a skip yet listed as paid`);
  }
  if (problems.length > 0) {
    throw new Error(`holdout split is inconsistent:\n  - ${problems.join("\n  - ")}`);
  }
};
