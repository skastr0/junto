import type { MemberSeverity } from "@shared/region-rollup";
import { HUE } from "./theme";

// Severity ladder colors — one-to-one with docs/rts-bottom-bar.md and the
// existing flag palette. Used by region chips and the minimap.
export const SEVERITY_HUE: Readonly<Record<MemberSeverity, string>> = {
  blocked: HUE.crimson,
  attention: HUE.amber,
  working: HUE.cyan,
  parked: HUE.violet,
  idle: HUE.steel,
};

export const severityHue = (severity: MemberSeverity | undefined): string =>
  severity ? SEVERITY_HUE[severity] : HUE.steel;
