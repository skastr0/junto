/**
 * Occupancy card chrome — the visual alphabet for the eight-state spectrum
 * (S5 cut 2, factory-physics-engineering-plan.md).
 *
 * Pure: OccupancySpectrum -> { CSS hook, accessible label }. Rendered via a
 * `data-occupancy` attribute (see NodeShell.tsx), the same pattern already
 * used for `data-blocked` / `data-herdr-blocked` — CSS in styles.css keys
 * off the attribute so this module never touches the DOM or React itself.
 *
 * I12: three vocabularies must never collapse into one badge — "needs
 * input" (attention, the occupant asking), "line stopped" (activity_blocked,
 * the packet), "stalled" (the clock). Each carries its own word below; a
 * table test in tests/occupancy-chrome.test.ts asserts they stay distinct.
 *
 * I20: `gone` reads "Machine unreachable" — never
 * stopped/revoked/compromised. There is no compromise inference from
 * unreachability.
 */
import type { OccupancySpectrumName } from "@shared/occupancy";

export type OccupancyVocabulary = "needs-input" | "line-stopped" | "stalled";

export interface OccupancyChromeSpec {
  readonly state: OccupancySpectrumName;
  /** data-occupancy attribute value; styles.css keys chrome off this. */
  readonly attr: OccupancySpectrumName;
  /** Accessible name (aria-label/title) — the only place the word appears. */
  readonly label: string;
  /** Present only for the three states I12 forbids collapsing together. */
  readonly vocabulary?: OccupancyVocabulary;
}

const SPEC: Readonly<Record<OccupancySpectrumName, OccupancyChromeSpec>> = {
  empty: { state: "empty", attr: "empty", label: "empty seat" },
  idle: { state: "idle", attr: "idle", label: "occupied" },
  working: { state: "working", attr: "working", label: "working" },
  attention: {
    state: "attention",
    attr: "attention",
    label: "needs input",
    vocabulary: "needs-input",
  },
  activity_blocked: {
    state: "activity_blocked",
    attr: "activity_blocked",
    label: "line stopped",
    vocabulary: "line-stopped",
  },
  stalled: {
    state: "stalled",
    attr: "stalled",
    label: "stalled",
    vocabulary: "stalled",
  },
  parked: { state: "parked", attr: "parked", label: "parked" },
  // I20: honest unreachability, never a compromise/revocation claim.
  gone: { state: "gone", attr: "gone", label: "Machine unreachable" },
};

/** Spectrum state -> card chrome spec. Total over OccupancySpectrum.literals. */
export function occupancyChrome(state: OccupancySpectrumName): OccupancyChromeSpec {
  return SPEC[state];
}
